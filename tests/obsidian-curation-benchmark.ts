// Explicit real-backend evaluation. Build outside the repository; output only to a private report path.
// Frozen synthetic cases, no actual note writes, no deletions, no credential access here.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import curationSkill from "../skills/knowledge-curation/SKILL.md";
import { parseCurationResult } from "../src/curation/policy";
import type { CurationContext } from "../src/curation/types";

export async function run(app: any, sessionId: string, fixturePath: string, output: string): Promise<unknown> {
	const vaultRoot = app.vault.adapter.getBasePath(); const within = (root: string) => { const relative = path.relative(root, path.resolve(output)); return !relative.startsWith("..") && !path.isAbsolute(relative); };
	if (within(vaultRoot) || within(path.resolve(path.dirname(fixturePath), "../.."))) throw new Error("Evaluation reports must be outside the vault and repository");
	const raw = await fs.readFile(fixturePath, "utf8"); const cases = JSON.parse(raw); if (cases.length !== 14) throw new Error("Frozen fourteen-case protocol required");
	const plugin = app.plugins.plugins["research-agent-reader"]; await plugin.getReadingWorkspace().ready(); const session = plugin.getReadingWorkspace().repository.get(sessionId); const backend = plugin.createReadingBackend(session, false);
	const records: any[] = []; const usage: any[] = []; const started = new Date().toISOString();
	for (let i = 0; i < cases.length; i += 5) {
		const batch = cases.slice(i, i + 5); const context = { target: { paragraphs: batch.map((c: any) => ({ id: c.id, text: c.existing, heading: c.id })) }, evidence: batch.map((c: any) => ({ id: c.id + "-E", kind: "paper", role: "本文原文", depth: "原文文本", origins: ["synthetic:" + c.id], text: c.evidence })), sourceCompatible: true } as CurationContext;
		const prompt = JSON.stringify({ instruction: "本轮为固定候选判别。每个 case 输出恰好一条 suggestion，paragraphId 为 case.id。只判定 proposed 本身，不修复或改写候选：claim 和 text 保持 proposed 原文。区分明确相反 conflict 与未研究/缺证 insufficient。不要把‘纠正后的新表述’作为 add。输出与生产一致的 suggestions JSON。", cases: batch.map(({ expected, ...c }: any) => ({ ...c, note: undefined })), evidence: context.evidence });
		let reported; const answer = await backend.complete({ system: curationSkill, prompt, images: [], signal: new AbortController().signal, maxTokens: 4500, onUsage: (u: any) => { reported = u; } });
		usage.push(reported || { estimatedInput: Math.ceil(Buffer.byteLength(curationSkill + prompt) / 3), estimatedOutput: Math.ceil(Buffer.byteLength(answer) / 3) });
		let suggestions; try { suggestions = parseCurationResult(answer, context); } catch (error) { records.push(...batch.map((c: any) => ({ id: c.id, expected: c.expected, error: String(error), raw: answer, pass: false }))); continue; }
		for (const c of batch) { const matches = suggestions.filter(s => s.paragraphId === c.id); const suggestion = matches[0]; records.push({ id: c.id, category: c.category, expected: c.expected, observed: suggestion?.kind, textUnchanged: suggestion?.text === c.proposed, suggestion, pass: matches.length === 1 && suggestion?.kind === c.expected && suggestion?.text === c.proposed, unsafeApplicable: c.expected !== "add" && !!suggestion?.applicable }); }
	}
	const result = { version: 1, started, completed: new Date().toISOString(), fixtureHash: createHash("sha256").update(raw).digest("hex"), backend: backend.name, model: backend.model, total: cases.length, passed: records.filter(r => r.pass).length, unsafeApplicable: records.filter(r => r.unsafeApplicable).length, usage, records, limits: "Synthetic classification probe, not a scientific accuracy estimate. Expected labels were frozen before execution." };
	await fs.writeFile(output, JSON.stringify(result, null, 2), { flag: "wx", encoding: "utf8" }); return { backend: result.backend, model: result.model, passed: result.passed, total: result.total, unsafeApplicable: result.unsafeApplicable, output };
}
