import type { ReadingLearningState, ReadingSession } from "./types";
import { readingNode } from "./session";
export const LEARNING_LABELS: Record<ReadingLearningState, string> = { unmarked: "未标记", understood: "已理解", revisit: "待回看", question: "仍有疑问" };
export function markReading(session: ReadingSession, id: string, state: ReadingLearningState): void {
	const node = readingNode(session, id);
	if (node.status !== "done" || !(state in LEARNING_LABELS)) throw new Error("只能标记已完成的回答");
	node.learningState = state;
}
export function visitReadingEvidence(session: ReadingSession, nodeId: string, evidenceId: string): void {
	if (!readingNode(session, nodeId).evidence.some(e => e.id === evidenceId)) throw new Error("原文引用不存在");
	const pane = session.ui.evidenceView ||= { history: [], cursor: -1, x: 24, y: 110, width: 520, height: 540 };
	const current = pane.history[pane.cursor];
	if (current?.nodeId === nodeId && current.evidenceId === evidenceId) return;
	pane.history = [...pane.history.slice(0, pane.cursor + 1), { nodeId, evidenceId }]; pane.cursor = pane.history.length - 1;
}
