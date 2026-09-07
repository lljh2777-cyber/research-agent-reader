import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantRun, AssistantStorage } from "./types";
import { ASSISTANT_CAPABILITIES } from "./capabilities";
const ID = /^a-[a-f0-9-]{36}$/;
export function validateAssistantRun(raw: unknown): AssistantRun {
	const r = raw as AssistantRun;
	const str = (v: unknown, max = 1000): v is string => typeof v === "string" && v.length <= max;
	const state = (v: string) => ["running", "done", "failed", "interrupted"].includes(v);
	const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
	const array = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
	if (!r || r.version !== 1 || !str(r.id) || !ID.test(r.id) || !str(r.sessionId, 100) || !str(r.nodeId, 100) || !str(r.profileId, 100) || !str(r.model) || !str(r.question, 4000) || !str(r.answer, 12000) || !str(r.error, 4000) || !str(r.created, 50) || !Number.isFinite(Date.parse(r.created)) || !state(r.state)
		|| !array(r.steps, 8) || !array(r.sources, 24) || !array(r.calls, 8) || !array(r.actions, 8) || !array(r.citations, 24)) throw new Error("助手记录无效");
	if (r.steps.some(s => !s || !ASSISTANT_CAPABILITIES.some(c => c.name === s.tool) || !str(s.summary, 300) || typeof s.cached !== "boolean" || typeof s.ok !== "boolean")
		|| r.calls.some(c => !c || !state(c.state) || !number(c.estimatedInput) || [c.input, c.output, c.cachedInput].some(n => n !== undefined && !number(n)))
		|| r.sources.some(s => !s || !/^S\d+$/.test(s.id) || !["paper", "knowledge"].includes(s.kind) || !str(s.path) || !str(s.label) || !str(s.text, 5000) || !str(s.hash, 64) || !str(s.role) || [s.start, s.end, s.page].some(n => n !== undefined && !number(n)))
		|| new Set(r.sources.map(s => s.id)).size !== r.sources.length || r.citations.some(id => !r.sources.some(s => s.id === id))
		|| r.actions.some(a => !a || !str(a.id, 50) || !["curation", "export", "advance"].includes(a.kind) || !["node", "branch", "session"].includes(a.scope) || !["prepared", "opened"].includes(a.state) || !array(a.nodeIds, 3) || !a.nodeIds.length || a.nodeIds.some(id => !str(id, 100)) || !str(a.target) || !/^[a-f0-9]{64}$/.test(a.contextHash))
		|| new Set(r.actions.map(a => a.id)).size !== r.actions.length) throw new Error("助手记录内容无效");
	return r;
}
export class FileAssistantStorage implements AssistantStorage {
	private root: string; private queue: Promise<unknown> = Promise.resolve();
	constructor(pluginDirectory: string) { this.root = path.join(pluginDirectory, "reading-assistant-runs"); }
	private async prepare() { await fs.mkdir(this.root, { recursive: true }); if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error("助手存储目录不能是符号链接"); }
	private filename(id: string) { if (!ID.test(id)) throw new Error("助手记录编号无效"); return path.join(this.root, id + ".json"); }
	async list() { await this.prepare(); return (await fs.readdir(this.root)).filter(n => n.endsWith(".json") && ID.test(n.slice(0, -5))).map(n => n.slice(0, -5)); }
	async read(id: string) { await this.prepare(); const filename = this.filename(id); const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("助手记录过大或无效"); return fs.readFile(filename, "utf8"); }
	write(id: string, text: string): Promise<void> {
		const task = this.queue.then(async () => { await this.prepare(); if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("助手记录超过容量"); const filename = this.filename(id);
			for (const p of [filename, filename + ".pending"]) try { const s = await fs.lstat(p); if (!s.isFile() || s.isSymbolicLink()) throw new Error("助手存储路径无效"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
			const f = await fs.open(filename + ".pending", "w", 0o600); try { await f.writeFile(text, "utf8"); await f.sync(); } finally { await f.close(); } await fs.rename(filename + ".pending", filename);
		}); this.queue = task.catch(() => undefined); return task;
	}
}
