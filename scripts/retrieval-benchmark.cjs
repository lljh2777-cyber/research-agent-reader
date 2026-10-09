/* Read-only corpus evaluation. Private snapshots/results MUST stay outside the
 * repository and vault. No source writes, file deletion, or model fallback. */
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const Module = require("node:module");
const { setTimeout: delay } = require("node:timers/promises");
const REPO = path.resolve(__dirname, "..");
const PREFIXES = ["sources", "concepts", "methods", "datasets", "synthesis", "mocs", "projects", "entities", "code", "r", "linux"].map((p) => "wiki/" + p + "/");
const CONFIG = Object.freeze({ version: 1, chunkChars: 1800, overlap: 160, candidateLimit: 64, fusionK: 60, embeddingBatch: 16,
	embedding: "BAAI/bge-m3", reranker: "BAAI/bge-reranker-v2-m3", dimensions: 1024, endpoint: "https://api.siliconflow.cn/v1" });
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const inside = (candidate, root) => { const relative = path.relative(root, candidate); return !relative || !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative); };
function assertOutput(out, vaultRoot) {
	const resolved = path.resolve(out);
	if (inside(resolved, REPO) || vaultRoot && inside(resolved, path.resolve(vaultRoot))) throw new Error("Private benchmark output must be outside the repository and vault");
	return resolved;
}
async function jsonRead(filename) { return JSON.parse(await fs.readFile(filename, "utf8")); }
async function jsonSave(filename, value, fresh = false) {
	const text = JSON.stringify(value, null, 2);
	if (fresh) return fs.writeFile(filename, text, { encoding: "utf8", flag: "wx" });
	await fs.writeFile(filename + ".pending", text, "utf8"); await fs.rename(filename + ".pending", filename);
}
function scoped(filePath) { return PREFIXES.some((prefix) => filePath.startsWith(prefix)) && !filePath.split("/").some((part) => part.startsWith(".")) && filePath.endsWith(".md"); }

async function capture(app, outDirectory) {
	const vaultRoot = app.vault.adapter.getBasePath(); const out = assertOutput(outDirectory, vaultRoot); await fs.mkdir(out, { recursive: true });
	const docs = [];
	for (const file of app.vault.getMarkdownFiles().filter((file) => scoped(file.path)).sort((a, b) => a.path.localeCompare(b.path))) {
		const text = await app.vault.read(file); const cache = app.metadataCache.getFileCache(file) || {}; const fm = cache.frontmatter || {};
		docs.push({ path: file.path, basename: file.basename, mtime: file.stat.mtime, text, hash: hash(text),
			metadata: { frontmatter: { title: fm.title, tags: fm.tags, aliases: fm.aliases }, headings: cache.headings, tags: cache.tags },
			depth: fm.reading_depth || fm.depth || fm.status || "unclassified", evidenceBasis: fm.evidence_basis || "unspecified" });
	}
	const corpusHash = hash(JSON.stringify(docs.map((doc) => [doc.path, doc.hash])));
	await jsonSave(path.join(out, "corpus.json"), { schema: 1, created: new Date().toISOString(), vaultRoot, corpusHash, docs }, true);
	return { documents: docs.length, corpusHash };
}
function clean(text) { return text.replace(/!\[[^\]]*\]\([^\n]*?\)/g, "").replace(/!\[\[[^\]]*\]\]/g, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target).trim(); }
function chunksFor(doc) {
	const title = String(doc.metadata.frontmatter.title || doc.basename); const parts = [];
	let bodyStart = 0; const fm = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(doc.text); if (fm) bodyStart = fm[0].length;
	const headers = [...doc.text.slice(bodyStart).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => ({ start: bodyStart + m.index, end: bodyStart + m.index + m[0].length, level: m[0].indexOf(" "), title: m[1].trim() }));
	const sections = []; let cursor = bodyStart; let trail = [];
	for (const header of headers) { if (header.start > cursor) sections.push({ start: cursor, end: header.start, heading: trail.filter(Boolean).join(" / ") }); trail = trail.slice(0, header.level - 1); trail[header.level - 1] = header.title; cursor = header.end; }
	if (cursor < doc.text.length) sections.push({ start: cursor, end: doc.text.length, heading: trail.filter(Boolean).join(" / ") });
	for (const section of sections) {
		let start = section.start;
		while (start < section.end) {
			let end = Math.min(section.end, start + CONFIG.chunkChars);
			if (end < section.end) { const paragraph = doc.text.lastIndexOf("\n\n", end); if (paragraph > start + CONFIG.chunkChars / 2) end = paragraph; }
			const text = clean(doc.text.slice(start, end));
			if (text.length) parts.push({ id: hash(doc.path + "|" + doc.hash + "|" + start + "|" + end).slice(0, 24), path: doc.path, start, end,
				title, heading: section.heading, text, input: title + "\n" + section.heading + "\n" + text });
			if (end === section.end) break; start = Math.max(start + 1, end - CONFIG.overlap);
		}
	}
	return parts;
}
function loadLexical() {
	const entry = path.join(REPO, "src/query/lexical-retrieval.ts");
	const code = require("esbuild").buildSync({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian"], logLevel: "silent" }).outputFiles[0].text;
	class TFile { constructor(doc) { this.path = doc.path; this.basename = doc.basename; this.stat = { mtime: doc.mtime }; } }
	const mod = new Module(entry, module); mod.filename = entry; mod.paths = Module._nodeModulePaths(REPO); const original = mod.require.bind(mod); mod.require = (name) => name === "obsidian" ? { TFile } : original(name); mod._compile(code, entry);
	return { ...mod.exports, TFile };
}
function validateQuestions(questions, docs) {
	if (!Array.isArray(questions) || !questions.length) throw new Error("Question set must not be empty");
	const byPath = new Map(docs.map((doc) => [doc.path, doc])); const seen = new Set(); const families = new Map();
	for (const q of questions) {
		if (typeof q.id !== "string" || !q.id.trim() || seen.has(q.id) || typeof q.query !== "string" || !q.query.trim() ||
			!["dev", "heldout"].includes(q.split) || !Array.isArray(q.evidence) || typeof q.noAnswer !== "boolean" || !q.family) throw new Error("Invalid or duplicate question " + q.id);
		seen.add(q.id);
		if (families.has(q.family) && families.get(q.family) !== q.split) throw new Error("Question family crosses splits: " + q.family);
		families.set(q.family, q.split);
		if (!q.noAnswer && !q.evidence.length) throw new Error("Answerable question needs evidence " + q.id);
		for (const evidence of q.evidence) if (typeof evidence.quote !== "string" || !evidence.quote.trim() || !byPath.get(evidence.path)?.text.includes(evidence.quote)) throw new Error("Unverified evidence anchor: " + q.id + " " + evidence.path);
		if (q.noAnswer && !q.absenceReason) throw new Error("Missing absence rationale: " + q.id);
	}
}
function metrics(questions, runs, k) {
	const answered = questions.filter((q) => !q.noAnswer); let hits = 0; let recall = 0; let mrr = 0;
	for (const q of answered) {
		const accepted = new Set(q.evidence.map((e) => e.path)); const found = [...new Set((runs[q.id] || []).map((item) => item.path))].slice(0, k);
		const rank = found.findIndex((item) => accepted.has(item)); if (rank >= 0) { hits++; mrr += 1 / (rank + 1); }
		recall += found.filter((item) => accepted.has(item)).length / accepted.size;
	}
	return { questions: answered.length, hit: answered.length ? hits / answered.length : null, referenceRecall: answered.length ? recall / answered.length : null, mrr: answered.length ? mrr / answered.length : null };
}
function fuse(lists, limit = CONFIG.candidateLimit) {
	const scores = new Map(); for (const list of lists) { const seen = new Set(); list.forEach((item, i) => { if (seen.has(item.id)) return; seen.add(item.id); scores.set(item.id, (scores.get(item.id) || 0) + 1 / (CONFIG.fusionK + i + 1)); }); }
	return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id, score]) => ({ id, score }));
}
function normalize(vector) {
	if (!Array.isArray(vector) || vector.length !== CONFIG.dimensions || !vector.every(Number.isFinite)) throw new Error("Invalid embedding dimensions or values");
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)); if (!norm) throw new Error("Zero embedding"); return vector.map((value) => value / norm);
}
function rankLexicalChunks(chunks, query, tokenize) {
	const terms = tokenize(query, 24);
	return chunks.map((chunk) => {
		const title = new Set(tokenize(chunk.title + " " + chunk.heading, 256)); const body = new Set(tokenize(chunk.text, 2000));
		return { ...chunk, score: terms.reduce((sum, term) => sum + (title.has(term) ? 6 : 0) + (body.has(term) ? 2 : 0), 0) };
	}).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
function docRanking(results, chunks) {
	const seen = new Set(); const ranked = [];
	if (results.length !== chunks.length || new Set(results.map((result) => result.index)).size !== chunks.length) throw new Error("Incomplete or duplicate rerank result");
	for (const result of [...results].sort((a, b) => b.relevance_score - a.relevance_score)) {
		const chunk = chunks[result.index]; if (!Number.isInteger(result.index) || !chunk || !Number.isFinite(result.relevance_score)) throw new Error("Invalid rerank result");
		if (seen.has(chunk.path)) continue; seen.add(chunk.path); ranked.push({ path: chunk.path, chunkId: chunk.id, score: result.relevance_score });
	}
	return ranked.slice(0, 10);
}
async function prepare(outDirectory) {
	const out = assertOutput(outDirectory); const corpus = await jsonRead(path.join(out, "corpus.json")); assertOutput(out, corpus.vaultRoot);
	const questions = await jsonRead(path.join(out, "questions.json")); validateQuestions(questions, corpus.docs);
	const chunks = corpus.docs.flatMap(chunksFor); const lexical = loadLexical(); const byPath = new Map(corpus.docs.map((doc) => [doc.path, doc]));
	const app = { vault: { getMarkdownFiles: () => corpus.docs.map((doc) => new lexical.TFile(doc)), cachedRead: async (file) => byPath.get(file.path).text }, metadataCache: { getFileCache: (file) => byPath.get(file.path).metadata } };
	const retriever = new lexical.LexicalVaultRetriever(app); const runs = {}; const timings = {}; const traces = {};
	for (const q of questions) { const start = performance.now(); const trace = await retriever.retrieve(q.query, [], { allowedPrefixes: PREFIXES.map((p) => p.slice(0, -1)) });
		if (trace.scope_complete === false || trace.indexed_files !== corpus.docs.length) throw new Error("Baseline index incomplete");
		runs[q.id] = trace.lexical_seeds; timings[q.id] = performance.now() - start; traces[q.id] = { candidates: trace.candidate_paths, terms: trace.lexical_terms };
	}
	const protocol = { ...CONFIG, corpusHash: corpus.corpusHash, chunkHash: hash(JSON.stringify(chunks)), questionHash: hash(JSON.stringify(questions)), lexicalSourceHash: hash(await fs.readFile(path.join(REPO, "src/query/lexical-retrieval.ts"))),
		corpusDocuments: corpus.docs.length, corpusChunks: chunks.length, labelSource: "agent-authored anchors, frozen before model calls; not human-reviewed",
		limits: ["Known-reference document metrics, not exhaustive relevance judgments", "No-answer cases report candidate presence/scores; no answer generation or hallucination metric", "Chunk selection is additional processing in rerank arms", "Baseline uses actual lexical class and captured Obsidian metadata with snapshot reads"] };
	await jsonSave(path.join(out, "protocol.json"), protocol, true); await jsonSave(path.join(out, "chunks.json"), chunks, true);
	await jsonSave(path.join(out, "baseline.json"), { status: "complete", runs, timings, traces }, true);
	await writeReport(out); return { documents: corpus.docs.length, chunks: chunks.length, questions: questions.length, hit5: metrics(questions, runs, 5).hit };
}

function post(route, body, key) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body); const req = https.request(CONFIG.endpoint + route, { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
			let response = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { response += chunk; if (response.length > 16_000_000) req.destroy(new Error("API response exceeds limit")); });
			res.on("end", () => { if (res.statusCode !== 200) { const error = new Error("SiliconFlow HTTP " + res.statusCode); error.status = res.statusCode; reject(error); return; }
				try { resolve(JSON.parse(response)); } catch { reject(new Error("Invalid API JSON")); }
			}); res.on("error", () => reject(new Error("API response interrupted")));
		});
		req.setTimeout(60000, () => req.destroy(new Error("API timeout"))); req.on("error", () => reject(new Error("API transport failure or timeout"))); req.end(data);
	});
}
async function optionalJson(filename, fallback) { try { return await jsonRead(filename); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } }
async function verifySources(corpus) {
	const changed = [];
	for (const doc of corpus.docs) { try { if (hash(await fs.readFile(path.join(corpus.vaultRoot, doc.path))) !== doc.hash) changed.push(doc.path); } catch { changed.push(doc.path); } }
	return { files: corpus.docs.length, unchanged: changed.length === 0, changed };
}
async function runOnline(outDirectory, key) {
	if (!key || !key.trim()) throw new Error("Missing SiliconFlow credential; baseline remains available");
	const out = assertOutput(outDirectory); const corpus = await jsonRead(path.join(out, "corpus.json")); assertOutput(out, corpus.vaultRoot);
	const questions = await jsonRead(path.join(out, "questions.json")); const chunks = await jsonRead(path.join(out, "chunks.json")); const protocol = await jsonRead(path.join(out, "protocol.json"));
	if (protocol.questionHash !== hash(JSON.stringify(questions)) || protocol.chunkHash !== hash(JSON.stringify(chunks)) || protocol.corpusHash !== corpus.corpusHash ||
		corpus.docs.some((doc) => hash(doc.text) !== doc.hash) || corpus.corpusHash !== hash(JSON.stringify(corpus.docs.map((doc) => [doc.path, doc.hash]))) ||
		protocol.lexicalSourceHash !== hash(await fs.readFile(path.join(REPO, "src/query/lexical-retrieval.ts"))) || Object.keys(CONFIG).some((k) => CONFIG[k] !== protocol[k])) throw new Error("Frozen protocol changed; use a new experiment directory");
	const baseline = await jsonRead(path.join(out, "baseline.json")); const { tokenizeForLexicalRetrieval: tokenize } = loadLexical();
	const vectors = await optionalJson(path.join(out, "vectors.json"), {}); const reranks = await optionalJson(path.join(out, "rerank-cache.json"), {});
	const online = await optionalJson(path.join(out, "online.json"), { status: "running", keywordRerank: {}, hybridRerank: {}, candidates: {}, timings: {}, api: [] });
	online.status = "running"; const byId = new Map(chunks.map((chunk) => [chunk.id, chunk])); let windowStart = Date.now(); let windowTokens = 0;
	const request = async (route, body) => {
		const estimate = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 2);
		if (Date.now() - windowStart > 60000) { windowStart = Date.now(); windowTokens = 0; }
		if (windowTokens + estimate > 180000) { await jsonSave(path.join(out, "progress.json"), { phase: "rate-limit pacing", updated: new Date().toISOString() }); await delay(Math.max(0, 60000 - (Date.now() - windowStart))); windowStart = Date.now(); windowTokens = 0; }
		windowTokens += estimate;
		for (let attempt = 0; attempt < 3; attempt++) { const start = performance.now(); try {
			const result = await post(route, body, key); online.api.push({ route, ms: Math.round(performance.now() - start), tokens: result.usage?.total_tokens ?? result.tokens?.input_tokens ?? null, attempt }); await delay(200); return result;
		} catch (error) { online.api.push({ route, ms: Math.round(performance.now() - start), status: error.status || "transport", attempt }); if (![429, 503, 504].includes(error.status) || attempt === 2) throw error; await delay(1000 * 2 ** attempt); } }
	};
	try {
		const items = [...chunks.map((c) => ({ input: c.input })), ...questions.map((q) => ({ input: q.query }))]; const pending = [...new Map(items.filter((item) => !vectors[hash(CONFIG.embedding + "|" + item.input)]).map((item) => [hash(item.input), item])).values()];
		for (let i = 0; i < pending.length; i += CONFIG.embeddingBatch) {
			const batch = pending.slice(i, i + CONFIG.embeddingBatch); const result = await request("/embeddings", { model: CONFIG.embedding, input: batch.map((item) => item.input), encoding_format: "float" });
			if (result.model && result.model !== CONFIG.embedding || !Array.isArray(result.data) || result.data.length !== batch.length) throw new Error("Embedding response mismatch");
			const indices = new Set(); for (const item of result.data) { if (!Number.isInteger(item.index) || !batch[item.index] || indices.has(item.index)) throw new Error("Embedding index mismatch"); indices.add(item.index); vectors[hash(CONFIG.embedding + "|" + batch[item.index].input)] = normalize(item.embedding); }
			await jsonSave(path.join(out, "vectors.json"), vectors); await jsonSave(path.join(out, "progress.json"), { phase: "embedding", done: Math.min(i + batch.length, pending.length), total: pending.length }); await jsonSave(path.join(out, "online.json"), online);
		}
		for (const [qi, q] of questions.entries()) {
			const lexical = rankLexicalChunks(chunks, q.query, tokenize); const paths = new Set(baseline.runs[q.id].map((item) => item.path));
			const candidatesB = lexical.filter((chunk) => paths.has(chunk.path)).slice(0, CONFIG.candidateLimit);
			const queryVector = vectors[hash(CONFIG.embedding + "|" + q.query)];
			const dense = chunks.map((chunk) => ({ id: chunk.id, score: vectors[hash(CONFIG.embedding + "|" + chunk.input)].reduce((sum, value, j) => sum + value * queryVector[j], 0) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
			const candidatesC = fuse([lexical.filter((chunk) => chunk.score > 0).slice(0, 64), dense.slice(0, 64)]).map((item) => byId.get(item.id));
			online.candidates[q.id] = { keyword: [...new Set(candidatesB.map((c) => c.path))], hybrid: [...new Set(candidatesC.map((c) => c.path))] };
			for (const [arm, candidates] of [["keywordRerank", candidatesB], ["hybridRerank", candidatesC]]) {
				if (online[arm][q.id]) continue; const started = performance.now(); const cacheKey = hash(CONFIG.reranker + "|" + q.query + "|" + candidates.map((c) => c.id).join(",")); let result = reranks[cacheKey]; const cacheHit = Boolean(result);
				if (!candidates.length) result = { results: [] };
				if (!result) { result = await request("/rerank", { model: CONFIG.reranker, query: q.query, documents: candidates.map((c) => c.input), top_n: candidates.length, return_documents: false });
					if (!Array.isArray(result.results) || result.results.length !== candidates.length || new Set(result.results.map((r) => r.index)).size !== candidates.length) throw new Error("Incomplete rerank result");
					result = { results: result.results }; reranks[cacheKey] = result; await jsonSave(path.join(out, "rerank-cache.json"), reranks);
				}
				online[arm][q.id] = docRanking([...result.results].sort((a, b) => b.relevance_score - a.relevance_score), candidates);
				online.timings[q.id + ":" + arm] = { ms: Math.round(performance.now() - started), cacheHit, candidates: candidates.length };
				await jsonSave(path.join(out, "online.json"), online);
			}
			await jsonSave(path.join(out, "progress.json"), { phase: "rerank", done: qi + 1, total: questions.length });
		}
		online.status = "complete"; online.integrity = await verifySources(corpus);
	} catch (error) { online.status = "incomplete"; online.error = error.message; throw error; }
	finally { await jsonSave(path.join(out, "online.json"), online); await writeReport(out); }
	return { status: online.status, requests: online.api.length, integrity: online.integrity };
}
async function writeReport(out) {
	const corpus = await jsonRead(path.join(out, "corpus.json")); const questions = await jsonRead(path.join(out, "questions.json")); const protocol = await jsonRead(path.join(out, "protocol.json")); const baseline = await jsonRead(path.join(out, "baseline.json"));
	const online = await optionalJson(path.join(out, "online.json"), null); const integrity = await verifySources(corpus);
	const pct = (value) => value === null ? "—" : (value * 100).toFixed(1) + "%";
	const arms = [["当前词法检索", baseline.runs], ["词法＋重排", online?.keywordRerank], ["混合检索＋重排", online?.hybridRerank]];
	const lines = ["# 知识库检索对比测试", "", "生成时间：" + new Date().toISOString(), "", "状态：" + (online?.status || "离线基线完成，在线两组等待硅基流动凭据"), "",
		`语料：${corpus.docs.length} 篇正式笔记，${protocol.corpusChunks} 个片段；${questions.length} 个问题，其中 ${questions.filter((q) => q.noAnswer).length} 个资料不足问题。`, "",
		"问题及引用片段由代理依据笔记编写，并在模型调用前冻结；未经过用户独立标注。指标表示已标注参考文件的命中情况，不能解释为完整相关性准确率或论文结论正确率。", "",
		"不修改正式笔记、不生成问答答案、不执行代码项目或重新核验论文图像。原有 x-ray / abstract-level / model-knowledge 等标签仅作为笔记元数据保留。", "",
		"## 主要结果", "", "| 方案 | 分组 | 完成题数 | Hit@1 | Hit@5 | 参考文件 Recall@5 | MRR@5 |", "|---|---|---:|---:|---:|---:|---:|"];
	for (const [label, runs] of arms) for (const split of ["dev", "heldout"]) {
		const group = questions.filter((q) => q.split === split && !q.noAnswer); const complete = Boolean(runs) && group.every((q) => Object.hasOwn(runs, q.id));
		if (!complete) { lines.push(`| ${label} | ${split} | ${group.filter((q) => runs?.[q.id]).length}/${group.length} | 待完成 | — | — | — |`); continue; }
		const one = metrics(group, runs, 1); const five = metrics(group, runs, 5); lines.push(`| ${label} | ${split} | ${group.length}/${group.length} | ${pct(one.hit)} | ${pct(five.hit)} | ${pct(five.referenceRecall)} | ${five.mrr === null ? "—" : five.mrr.toFixed(3)} |`);
	}
	if (online) {
		const chunks = await jsonRead(path.join(out, "chunks.json"));
		const byId = new Map(chunks.map((chunk) => [chunk.id, chunk])); const docs = new Map(corpus.docs.map((doc) => [doc.path, doc]));
		lines.push("", "## 候选与片段诊断", "", "仅统计各组已完成的有依据问题。片段命中要求前五篇的代表片段中出现至少一条标注原句；它是严格字符串检查，不能替代完整语义评审。", "",
			"| 方案 | 已完成题数 | 重排前参考文件 Recall | 前五代表片段原句命中 |", "|---|---:|---:|---:|");
		for (const [arm, key, label] of [["keywordRerank", "keyword", "词法＋重排"], ["hybridRerank", "hybrid", "混合＋重排"]]) {
			const group = questions.filter((q) => !q.noAnswer && Object.hasOwn(online[arm], q.id)); const candidates = {}; let anchorHits = 0;
			for (const q of group) {
				candidates[q.id] = (online.candidates[q.id]?.[key] || []).map((filePath) => ({ path: filePath }));
				if (online[arm][q.id].slice(0, 5).some((result) => { const chunk = byId.get(result.chunkId); return chunk && q.evidence.some((e) => e.path === chunk.path && docs.get(chunk.path).text.slice(chunk.start, chunk.end).includes(e.quote)); })) anchorHits++;
			}
			lines.push(`| ${label} | ${group.length} | ${pct(metrics(group, candidates, Infinity).referenceRecall)} | ${pct(group.length ? anchorHits / group.length : null)} |`);
		}
		lines.push("", "## 请求耗时与计量", "", "API 耗时只计请求发出至响应完成；不含本地检索、索引构建和主动限流等待。实验逐题耗时含等待，不代表常态单次问答延迟。未返回的 token 计量不推算为零，也不据此计算费用。", "",
			"| API | 成功请求 | P50 / P95 毫秒 | 返回 token 计量的请求 | 已报告 token 合计 |", "|---|---:|---:|---:|---:|");
		for (const route of ["/embeddings", "/rerank"]) {
			const entries = online.api.filter((item) => item.route === route && !item.status); const ms = entries.map((item) => item.ms).sort((a, b) => a - b);
			const measured = entries.filter((item) => Number.isFinite(item.tokens)); const quantile = (p) => ms.length ? ms[Math.max(0, Math.ceil(ms.length * p) - 1)] : "—";
			lines.push(`| ${route} | ${entries.length} | ${quantile(0.5)} / ${quantile(0.95)} | ${measured.length}/${entries.length} | ${measured.length ? measured.reduce((sum, item) => sum + item.tokens, 0) : "未提供"} |`);
		}
		lines.push("", "## 资料不足问题的相关性分数", "", "以下分数不能作为自动拒答或自动入库阈值；不同组的词法分与模型分也不能直接比较。", "", "| 问题 | 当前词法首位分 | 词法＋重排首位分 | 混合＋重排首位分 |", "|---|---:|---:|---:|");
		for (const q of questions.filter((item) => item.noAnswer)) lines.push(`| ${q.id} | ${arms.map(([, runs]) => { const first = runs?.[q.id]?.[0]; return first ? first.score.toFixed(4) : runs?.[q.id] ? "无候选" : "待完成"; }).join(" | ")} |`);
	}
	lines.push("", "## 评估边界", "", "- 复用仓库实际词法检索代码和 Obsidian 元数据；读取冻结快照，索引读盘耗时与生产环境不同。", "- 两组重排均使用最多 64 个片段，再按每篇笔记最高分合并。混合组融合词法与向量各前 64 个片段；参数预先固定。", "- 重排组增加了段落切分，改善不能全部归因于模型；主要指标统一在文件层比较。", "- 返回了主题相关候选并不说明能够回答资料不足问题；本测试没有生成答案，因此不报告幻觉率或拒答准确率。", "- 正式笔记中也包含模型通用知识和外部来源整理；笔记类型不等于原文级事实核验。", "- 每题参考依据并非穷尽标注，未标注但有用的结果可能被漏计。", "",
		"## 逐题结果与参考依据", "");
	for (const q of questions) { lines.push(`### ${q.id} · ${q.query}`, "", `分组：${q.split}；类型：${q.category}；${q.noAnswer ? "资料不足" : "有参考依据"}`, "", "判定依据：" + (q.absenceReason || q.answer), "");
		for (const evidence of q.evidence) lines.push("- `" + evidence.path + "`：" + evidence.quote);
		for (const [label, runs] of arms) lines.push("", label + "：" + (runs?.[q.id]?.slice(0, 5).map((item) => "`" + item.path + "`").join("；") || (runs?.[q.id] ? "未返回候选" : "待完成")));
		lines.push("");
	}
	lines.push("## 复现与来源完整性", "", "- 语料哈希：`" + protocol.corpusHash + "`", "- 问题哈希：`" + protocol.questionHash + "`", "- 当前源文件校验：" + (integrity.unchanged ? "全部未变化" : "存在变化：" + integrity.changed.join("、")), "- 私有语料、问题和结果仅保存在本机实验目录；仓库只保存通用脚本与合成测试。", "- 检索范围：排除 papers、qa、annotations、日志、顶层导航索引和 wiki/index.md；范围内的 MOC 和项目页仍纳入。参考片段须直接阅读核验，不能用检索分数替代证据。", "");
	await fs.writeFile(path.join(out, "report.md"), lines.join("\n"), "utf8");
	return { integrity };
}
module.exports = { capture, prepare, runOnline, writeReport, chunksFor, validateQuestions, metrics, fuse, normalize, docRanking, scoped, CONFIG };
async function credentialFromStdin() {
	let value = "";
	for await (const chunk of process.stdin) { value += chunk.toString("utf8"); if (value.length > 4096) throw new Error("Credential input exceeds limit"); }
	return value.trim();
}
if (require.main === module) {
	const [command, directory] = process.argv.slice(2);
	const operation = command === "prepare" ? prepare(directory)
		: command === "online" ? runOnline(directory, process.env.SILICONFLOW_API_KEY)
		: command === "online-stdin" ? credentialFromStdin().then((key) => runOnline(directory, key))
		: command === "report" ? writeReport(assertOutput(directory))
		: Promise.reject(new Error("Usage: node scripts/retrieval-benchmark.cjs prepare|online|online-stdin|report OUTSIDE_DIRECTORY"));
	operation.then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
