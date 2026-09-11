import * as path from "node:path";
import { parseAcquisitionInput } from "../fulltext/contracts";
import { SourceCatalog } from "../papers/catalog";
import { bytesDigest, safeCitekey } from "../papers/identity";
import { noteIdentifiers } from "../papers/note-identity";
import { loadSourcePackage } from "../sources/package";
import type { SourceStorage } from "../sources/storage";
import { readAnnotationRecords } from "../annotations/annotation-service";
import { validateReadingSession } from "../reading/session";
import { structuredFingerprint } from "../reading/structured-source";
import { readingCategory } from "../reading/catalog";
import type { ReadingSession } from "../reading/types";
import { projectLibrary } from "./projection";
import { listPaperRecordIds, readPaperRecord, type PaperRecordStatus } from "./record-store";
import type { LibraryIdentifiers, LibraryObject, LibraryProjection, LibrarySourceObject, LibrarySourceBinding } from "./types";

export type LibraryReadStorage = Pick<SourceStorage, "read" | "list">;
export interface LibraryReadIssue { area: "sources" | "notes" | "annotations" | "sessions" | "records"; path: string; message: string; blocksRecords?: boolean; }
export interface LibraryReadResult extends LibraryProjection {
	readIssues: LibraryReadIssue[];
	recordStates: PaperRecordStatus[];
	stats: { filesRead: number; bytesRead: number; directoriesRead: number; objects: number; elapsedMs: number };
	/** Any read failure or unsupported legacy object is visible; this is not an integrity badge. */
	complete: boolean;
}
export interface LibraryReaderOptions {
	vaultRoot: string;
	parseYaml(text: string): unknown;
	/** Trusted read-only validator; its own IO has separate limits and is not included in stats. */
	verifyMineru?: (articlePath: string) => Promise<void>;
	maxBytes?: number;
	signal?: AbortSignal;
}
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const message = (error: unknown): string => error instanceof Error ? error.message : typeof error === "string" ? error : "读取失败";
const deny = async (): Promise<never> => { throw new Error("文献列表不允许写入"); };
const fileName = (value: string): string => value.split("/").pop()!.replace(/\.md$/i, "");

/** Single-scan local adapter; no repository.load(), startup recovery, provider or model calls. */
export async function readPaperLibrary(vault: LibraryReadStorage, plugin: LibraryReadStorage, options: LibraryReaderOptions): Promise<LibraryReadResult> {
	const started = performance.now(), stats = { filesRead: 0, bytesRead: 0, directoriesRead: 0, objects: 0, elapsedMs: 0 };
	const limit = options.maxBytes ?? 256 * 1024 * 1024, issues: LibraryReadIssue[] = [], objects: LibraryObject[] = [];
	if (!Number.isSafeInteger(limit) || limit <= 0 || !path.isAbsolute(options.vaultRoot)) throw new Error("文献读取预算或 Vault 根路径无效");
	let exhausted: Error | undefined;
	const checkScan = () => { options.signal?.throwIfAborted(); if (exhausted) throw exhausted; };
	const budgetExceeded = (): never => { exhausted = new Error("文献读取超过总预算，请缩小范围或显式增加读取预算"); throw exhausted; };
	const issue = (area: LibraryReadIssue["area"], name: string, error: unknown, blocksRecords = true) => { checkScan(); issues.push({ area, path: name, message: message(error), ...(blocksRecords ? {} : { blocksRecords: false }) }); };
	const meter = (reader: LibraryReadStorage): SourceStorage => ({
		async list(name) { checkScan(); if (++stats.directoriesRead > 4096) budgetExceeded(); return [...await reader.list(name)].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); },
		async read(name, max = 256 * 1024) {
			checkScan(); if (++stats.filesRead > 10000 || stats.bytesRead >= limit) budgetExceeded();
			const remaining = limit - stats.bytesRead;
			try {
				const bytes = await reader.read(name, Math.min(max, remaining));
				if (bytes) { stats.bytesRead += bytes.length; if (bytes.length > max || stats.bytesRead > limit) budgetExceeded(); }
				return bytes;
			} catch (error) { if (remaining < max) budgetExceeded(); throw error; }
		}, mkdir: deny, create: deny,
	});
	const v = meter(vault), p = meter(plugin), sources = new Map<string, LibrarySourceObject>(), markdown = new Map<string, string>();
	const canonicalPath = (raw: string): string | undefined => {
		const normalized = raw.replace(/\\/g, "/");
		const relative = path.isAbsolute(normalized) ? path.relative(options.vaultRoot, normalized).replace(/\\/g, "/") : normalized;
		if (!relative || relative.split("/").some(part => !part || part === "." || part === "..") || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return;
		return relative;
	};
	const metadata = (text: string): { title?: string; identifiers: LibraryIdentifiers; citekey?: string } => {
		if (!/^---\r?\n/.test(text)) return { identifiers: {} };
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
		if (!match) throw new Error("文献属性未闭合");
		const value = options.parseYaml(match[1]);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("文献属性不是对象");
		const raw = value as Record<string, unknown>, normalized = noteIdentifiers(raw), identifiers: LibraryIdentifiers = {};
		for (const kind of ["doi", "pmid", "pmcid"] as const) if (normalized[kind]) {
			const parsed = parseAcquisitionInput((kind === "doi" ? "" : kind + ":") + normalized[kind]);
			if (parsed.kind !== kind) throw new Error("文献标识类型不一致"); identifiers[kind] = parsed.value;
		}
		if (raw.citekey !== undefined && !safeCitekey(raw.citekey)) throw new Error("文献 citekey 无效");
		return { identifiers, ...(typeof raw.title === "string" ? { title: raw.title } : {}), ...(raw.citekey ? { citekey: raw.citekey as string } : {}) };
	};
	const walk = async (root: string, area: LibraryReadIssue["area"], visit: (name: string) => Promise<void>, nested = true): Promise<void> => {
		const queue = [root];
		while (queue.length) {
			const dir = queue.shift()!;
			try {
				for (const entry of await v.list(dir)) {
					if (entry.name.startsWith(".") || entry.name === "_translations") continue;
					const name = dir + "/" + entry.name;
					if (entry.directory) { if (nested) queue.push(name); }
					else if (/\.md$/i.test(name)) { try { await visit(name); } catch (error) { issue(area, name, error); } }
				}
			} catch (error) { issue(area, dir, error); }
		}
	};
	const addSource = (item: LibrarySourceObject) => { sources.set(item.source.path, item); objects.push(item); };
	try {
		const inventory = await new SourceCatalog(v).inspect();
		checkScan();
		for (const entry of inventory.packages) {
			const m = entry.manifest;
			if (!m) {
				addSource({ kind: "source", id: entry.path, title: fileName(entry.path), identifiers: {}, source: { format: "unknown", path: entry.path, saved: false, verification: { state: "invalid", reason: entry.error || "原文包无效" } } });
				issue("sources", entry.path, entry.error); continue;
			}
			const name = entry.path + (m.packageKind === "pdf-source" ? "/source.pdf" : "/article.md");
			const item: LibrarySourceObject = { kind: "source", id: name, paperId: m.paperId, citekey: m.citekey, identifiers: { ...m.identity.identifiers }, title: m.identity.title,
				source: { format: m.packageKind === "pdf-source" ? "pdf" : "jats", path: name, packageKey: m.packageKey, sourceVersionId: m.sourceVersionId,
					...(m.packageKind === "jats-source" ? { projectionId: m.projectionId } : {}), saved: true, verification: { state: "unverified", reason: "等待完整原文核验" } } };
			try {
				const loaded = await loadSourcePackage(v, m.packageKey);
				if (loaded.manifest.digest !== m.digest) throw new Error("原文清单在扫描期间变化");
				item.source.verification = { state: "verified", fingerprint: m.packageKind === "pdf-source" ? m.files[0].sha256 : structuredFingerprint({ version: 1, format: "jats", manifest: m }) };
			} catch (error) { item.source.verification = { state: "invalid", reason: message(error) }; issue("sources", name, error); }
			addSource(item);
		}
		for (const name of inventory.legacyArticles) {
			const item: LibrarySourceObject = { kind: "source", id: name, title: fileName(name.replace(/\/article.md$/, "")), identifiers: {}, source: { format: "mineru", path: name, saved: true, verification: { state: "unverified", reason: "旧 MinerU 包尚未完整核验" } } };
			try {
				const article = await v.read(name, 16 * 1024 * 1024), manifest = await v.read(name.replace(/article.md$/, "_extraction/manifest.json"), 2 * 1024 * 1024);
				if (!article || !manifest) throw new Error("旧原文或提取清单缺失");
				const text = decode(article); markdown.set(name, text); Object.assign(item, metadata(text));
				if (options.verifyMineru) {
					await options.verifyMineru(name);
					const afterArticle = await v.read(name, 16 * 1024 * 1024), afterManifest = await v.read(name.replace(/article.md$/, "_extraction/manifest.json"), 2 * 1024 * 1024);
					const fingerprint = bytesDigest(Buffer.concat([article, manifest]));
					if (!afterArticle || !afterManifest || bytesDigest(Buffer.concat([afterArticle, afterManifest])) !== fingerprint) throw new Error("旧原文在扫描期间变化");
					item.source.verification = { state: "verified", fingerprint };
				} else issue("sources", name, "未提供 MinerU 完整验证器；保留为未核验来源", false);
			} catch (error) { item.source.verification = { state: "invalid", reason: message(error) }; issue("sources", name, error); }
			addSource(item);
		}
	} catch (error) { issue("sources", "papers", error); }
	await walk("Clippings", "sources", async name => {
		const bytes = await v.read(name, 16 * 1024 * 1024); if (!bytes) throw new Error("剪藏文件已不存在");
		const text = decode(bytes); markdown.set(name, text);
		let meta: ReturnType<typeof metadata> = { identifiers: {} }; try { meta = metadata(text); } catch (error) { issue("sources", name, error); }
		addSource({ kind: "source", id: name, title: meta.title || fileName(name), ...meta, source: { format: "markdown", path: name, saved: true, verification: { state: "verified", fingerprint: bytesDigest(bytes) } } });
	});
	await walk("wiki/sources", "notes", async name => {
		const bytes = await v.read(name, 2 * 1024 * 1024); if (!bytes) throw new Error("论文笔记已不存在");
		const text = decode(bytes); let meta: ReturnType<typeof metadata> = { identifiers: {} };
		try { meta = metadata(text); } catch (error) { issue("notes", name, error); }
		objects.push({ kind: "note", id: name, title: meta.title || fileName(name), ...meta, contentHash: bytesDigest(bytes) });
	}, false);
	await walk("wiki/annotations", "annotations", async name => {
		const bytes = await v.read(name, 2 * 1024 * 1024); if (!bytes) throw new Error("批注文件已不存在");
		const parsed = readAnnotationRecords(decode(bytes), name);
		for (const error of parsed.errors) issue("annotations", name, error);
		for (const record of parsed.records) {
			const sourcePath = canonicalPath(record.sourcePath), source = sourcePath && sources.get(sourcePath);
			// Old annotations have anchors, but no immutable source fingerprint. Keep a hint,
			// never copy present-day bibliographic identity into the historical annotation.
			const binding: LibrarySourceBinding = { state: "unresolved", ...(source ? { sourceId: source.id } : {}), reason: "旧批注没有固定来源指纹，需核对后确认关联" };
			const text = sourcePath && markdown.get(sourcePath), anchor = record.sourceAnchor;
			if (text && anchor && text.slice(anchor.start, anchor.end) !== record.selectedText) { binding.state = "changed"; binding.reason = "旧批注位置与当前原文不同，未重新绑定"; }
			objects.push({ kind: "annotation", id: name + "#" + record.id, title: record.section || record.selectedText.slice(0, 80), identifiers: {},
				roles: ["original_quote", ...(record.manualText ? ["personal_note" as const] : []), ...(record.aiText ? ["ai_explanation" as const] : [])], binding });
		}
	});
	const sessionIds = new Set<string>();
	for (const directory of ["reading-sessions", "reading-test-sessions", "code-reading-sessions"]) {
		try {
			for (const entry of await p.list(directory)) {
				if (entry.directory || !entry.name.endsWith(".json")) continue;
				const name = directory + "/" + entry.name;
				try {
					const bytes = await p.read(name, 64 * 1024 * 1024); if (!bytes) throw new Error("阅读会话文件已不存在");
					const session: ReadingSession = validateReadingSession(JSON.parse(decode(bytes)));
					if (entry.name !== session.id + ".json" || sessionIds.has(session.id)) throw new Error("会话文件名或重复 ID 不一致"); sessionIds.add(session.id);
					// Storage scope is authoritative even for old files without an explicit purpose.
					if (directory === "reading-test-sessions" && session.purpose !== "test") {
						issue("sessions", name, "测试目录与会话用途不一致，按测试会话排除"); session.purpose = "test";
					}
					if (directory === "code-reading-sessions" && session.source.kind !== "code") throw new Error("代码目录含论文会话，未纳入正式文献");
					let identifiers: LibraryIdentifiers = {}, paperId: string | undefined, citekey: string | undefined;
					let binding: LibrarySourceBinding | undefined;
					if (readingCategory(session) === "reading" && session.source.kind !== "code") {
						if (session.source.kind === "structured") { const m = session.source.structured!.manifest; identifiers = { ...m.identity.identifiers }; paperId = m.paperId; citekey = m.citekey; }
						const key = canonicalPath(session.source.path), source = key && sources.get(key);
						binding = { state: "unresolved", ...(source ? { sourceId: source.id } : {}), reason: "来源未进入已核验目录，历史会话保持独立" };
						if (source && source.source.verification.state === "verified") {
							const kind = { pdf: "pdf", mineru: "article", jats: "structured", markdown: "markdown", unknown: "unknown" }[source.source.format];
							if (kind === session.source.kind && source.source.verification.fingerprint === session.source.fingerprint) binding = { state: "matched", sourceId: source.id, fingerprint: session.source.fingerprint, reason: "来源类型与固定指纹一致" };
							else binding = { state: "changed", sourceId: source.id, reason: "当前路径的来源类型或指纹与历史不同，未重新绑定" };
						}
					}
					objects.push({ kind: "session", id: session.id, title: session.title, identifiers, ...(paperId ? { paperId } : {}), ...(citekey ? { citekey } : {}), session, ...(binding ? { binding } : {}) });
				} catch (error) { issue("sessions", name, error); }
			}
		} catch (error) { issue("sessions", directory, error); }
	}
	checkScan();
	const recordStates: PaperRecordStatus[] = [];
	try {
		for (const paperId of await listPaperRecordIds(p)) {
			const state = await readPaperRecord(p, paperId); checkScan();
			recordStates.push({ paperId, heads: state.heads, pending: state.pending, blocked: state.errors.length > 0 });
			for (const error of state.errors) issue("records", "paper-records/" + paperId, error);
			if (state.heads.length > 1) issue("records", "paper-records/" + paperId, "文献人工记录存在并发冲突，需选择保留的决定", false);
			if (state.pending.length) issue("records", "paper-records/" + paperId, "存在未提交的人工记录尝试，已保留并忽略", false);
			if (state.current) objects.push(state.current.record);
			else if (!state.errors.length && state.heads.length > 1) {
				const { primaryNoteId: ignored, ...identity } = state.revisions[0].record;
				objects.push({ ...identity, readingState: "unmarked", decisionConflict: true });
			}
		}
	} catch (error) { issue("records", "paper-records", error); }
	checkScan();
	const result = projectLibrary(objects); stats.objects = objects.length; stats.elapsedMs = Math.round(performance.now() - started);
	return { ...result, readIssues: issues, recordStates, stats, complete: issues.length === 0 };
}
