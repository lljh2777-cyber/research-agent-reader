import { createHash } from "node:crypto";
import type { ReadingEvidence, ReadingNode, ReadingSession } from "./types";

export const answerHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export function effectiveReadingContent(session: ReadingSession, node: ReadingNode): string {
	const corrected = session.nodes.find(n => n.id === node.acceptedCorrectionId && n.status === "done" && n.correction?.of === node.id && n.correction.originalHash === answerHash(node.content));
	return corrected ? "用户选择的核对版本（仍需本轮原文支持事实）：\n" + corrected.content : node.content;
}
export function acceptReadingCorrection(session: ReadingSession, id: string): void {
	const correction = session.nodes.find(n => n.id === id); const original = session.nodes.find(n => n.id === correction?.correction?.of);
	if (!correction || correction.status !== "done" || !original || correction.correction!.originalHash !== answerHash(original.content)) throw new Error("核对版本尚未完成或原回答已变化");
	original.acceptedCorrectionId = correction.id;
}
export function readingCoverage(session: ReadingSession, catalog: ReadingEvidence[]) {
	const done = session.nodes.filter(n => n.status === "done");
	return catalog.filter(e => e.kind === "paper" || e.kind === "code").map(evidence => {
		const provided = done.find(n => (evidence.asset ? n.providedImageIds : n.providedEvidenceIds)?.includes(evidence.id));
		const legacy = done.find(n => n.evidence.some(e => e.id === evidence.id && e.kind === evidence.kind && (!evidence.asset || e.visualInspected)));
		const reviewed = done.find(n => n.reviewedEvidence?.includes(evidence.id));
		return { evidence, provided: Boolean(provided), legacy: Boolean(legacy), reviewed: Boolean(reviewed), nodeId: reviewed?.id || provided?.id || legacy?.id || "" };
	});
}
