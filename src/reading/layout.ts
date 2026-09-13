import type { ReadingSession } from "./types";
import { layoutLearning } from "../learning/graph";
export { LEARNING_MAP as READING_MAP, type LearningPosition as ReadingPosition } from "../learning/graph";
import type { LearningPosition } from "../learning/graph";
export function layoutReading(session: ReadingSession): { nodes: LearningPosition[]; width: number; height: number } {
	return layoutLearning({ mainIds: session.mainIds, branches: session.branches, collapsed: session.ui.collapsed });
}
