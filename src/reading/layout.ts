import type { ReadingSession } from "./types";
export interface ReadingPosition { id: string; x: number; y: number; hiddenCount: number }
export const READING_MAP = { width: 224, height: 108, lane: 296, row: 164, inset: 44 };
export function layoutReading(session: ReadingSession): { nodes: ReadingPosition[]; width: number; height: number } {
	const nodes: ReadingPosition[] = [];
	const positions = new Map<string, ReadingPosition>();
	const occupied = new Set<string>();
	const add = (id: string, lane: number, row: number, hiddenCount = 0): void => {
		const node = { id, x: READING_MAP.inset + lane * READING_MAP.lane, y: READING_MAP.inset + row * READING_MAP.row, hiddenCount };
		nodes.push(node); positions.set(id, node); occupied.add(lane + ":" + row);
	};
	session.mainIds.forEach((id, row) => add(id, 0, row));
	for (const branch of session.branches) {
		const parent = positions.get(branch.parentNodeId);
		if (!parent || !branch.nodeIds.length) continue;
		const collapsed = session.ui.collapsed.includes(branch.id);
		const ids = collapsed ? branch.nodeIds.slice(0, 1) : branch.nodeIds;
		const row = Math.round((parent.y - READING_MAP.inset) / READING_MAP.row);
		let lane = Math.round((parent.x - READING_MAP.inset) / READING_MAP.lane) + 1;
		while (ids.some((_, i) => occupied.has(lane + ":" + (row + i)))) lane++;
		ids.forEach((id, i) => add(id, lane, row + i, collapsed ? branch.nodeIds.length - 1 : 0));
	}
	return { nodes, width: Math.max(620, ...nodes.map((node) => node.x + READING_MAP.width + READING_MAP.inset)), height: Math.max(480, ...nodes.map((node) => node.y + READING_MAP.height + 96)) };
}
