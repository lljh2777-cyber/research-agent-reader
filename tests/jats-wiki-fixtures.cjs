"use strict";
const assert = require("node:assert/strict"), { createHash } = require("node:crypto"), { loadReading } = require("./reading-test-helpers"), f = require("./jats-fixtures.cjs");
const parseYaml = text => Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map(line => { const i = line.indexOf(":"); return [line.slice(0, i), JSON.parse(line.slice(i + 1).trim())]; }));
const obsidian = { parseYaml, normalizePath: s => s.replace(/\\/g, "/") };
const { JatsWikiService } = loadReading("jats/wiki-service.ts", { obsidian });
const { JatsIntakeService } = loadReading("jats/intake.ts"), { SourceCatalog } = loadReading("papers/catalog.ts");
const trustedFs = { createTrustedVaultTextFile: async (adapter, p, text) => { assert.ok(!adapter.files.has(p), "create-only"); adapter.files.set(p, text); adapter.writes.push(p); }, readTrustedVaultFile: async (adapter, p) => Buffer.from(adapter.files.get(p)) };
const { commitSourceNote } = loadReading("agent/tools.ts", { obsidian, "../runtime/trusted-vault-fs": trustedFs });
exports.obsidian = obsidian; exports.JatsWikiService = JatsWikiService; exports.SourceCatalog = SourceCatalog; exports.f = f;
exports.answer = (title, id) => ({ status: "completed", title, title_zh: "合成测试论文", researchQuestion: `仅用于验证研究问题字段。[${id}]`, conclusion: `仅用于验证结论字段，不代表实际科研发现。[${id}]`, motivation: `仅用于验证问题动机字段。[${id}]`, evidenceGaps: "图表与全文方法未核验。", evidenceIds: [id], notes: [] });
exports.fixture = async () => {
	const input = f.fixture(), xml = Buffer.from(input.xml.toString().replace("Example abstract.", "This synthetic abstract is long enough to exercise bounded draft tools. It does not represent a scientific finding, experiment, or real publication claim."));
	input.metadata.xml_url = input.metadata.xml_url.replace(/md5=[a-f0-9]+/, "md5=" + createHash("md5").update(xml).digest("hex"));
	const download = input.transport.download; input.transport.download = async (url, signal, sink, progress, policy) => { if (!url.endsWith(".xml")) return download(url, signal, sink, progress, policy); signal.throwIfAborted(); policy.budget.received += xml.length; await sink.write(xml); progress(xml.length); };
	const acquired = await input.acquire(), source = f.storage(), journal = f.storage(), index = f.index(), notes = new Map(), writes = [], catalog = new SourceCatalog(source);
	const intake = new JatsIntakeService({ deviceId: f.sha("device"), catalog, journal: f.storage(), index, read: async () => acquired, link: async () => {} });
	let key; try { const p = await intake.prepare(acquired.snapshot.jobId); assert.equal((await intake.save(p.requestId, p.evidenceDigest, false)).phase, "saved"); key = p.packageKey; } finally { await intake.dispose(); }
	const deps = { catalog, journal, readNote: async p => notes.get(p) ?? null,
		commit: async (citekey, fields, content, created, verify) => { await commitSourceNote({ app: { vault: { adapter: { files: notes, writes } } } }, citekey, fields, "", { expectedContent: content, created, beforeCreate: verify }); },
		run: async request => {
			const result = await request.tools[0].execute({ mode: "overview" }, { signal: request.signal }), output = JSON.parse(result.output);
			return { status: "completed", final: exports.answer(acquired.snapshot.identity.title, output.evidence[0].id), toolCalls: [{ tool: "jats_read", ok: true, data: result.receiptData }], trace: "synthetic", steps: [] };
		} };
	const service = new JatsWikiService(deps), context = await service.inspect(key);
	return { key, source, journal, notes, writes, deps, service, context, acquired, generate: () => service.generate(key, context.source.manifest.digest, "mock") };
};
