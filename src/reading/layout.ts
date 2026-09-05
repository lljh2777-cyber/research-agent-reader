import type { ReadingSession } from "./types";
export interface ReadingPosition { id: string; x: number; y: number; hiddenCount: number }
export function layoutReading(session: ReadingSession): { nodes: ReadingPosition[]; width: number; height: number } {
	const nodes: ReadingPosition[] = [];
	const positions = new Map<string, ReadingPosition>();
	const occupied = new Set<string>();
	const add = (id: string, lane: number, row: number, hiddenCount = 0): void => {
		const node = { id, x: 40 + lane * 280, y: 40 + row * 116, hiddenCount };
		nodes.push(node); positions.set(id, node); occupied.add(lane + ":" + row);
	};
	session.mainIds.forEach((id, row) => add(id, 0, row));
	for (const branch of session.branches) {
		const parent = positions.get(branch.parentNodeId);
		if (!parent || !branch.nodeIds.length) continue;
		const collapsed = session.ui.collapsed.includes(branch.id);
		const ids = collapsed ? branch.nodeIds.slice(0, 1) : branch.nodeIds;
		const row = Math.round((parent.y - 40) / 116);
		let lane = Math.round((parent.x - 40) / 280) + 1;
		while (ids.some((_, i) => occupied.has(lane + ":" + (row + i)))) lane++;
		ids.forEach((id, i) => add(id, lane, row + i, collapsed ? branch.nodeIds.length - 1 : 0));
	}
	return { nodes, width: Math.max(640, ...nodes.map((node) => node.x + 280)), height: Math.max(500, ...nodes.map((node) => node.y + 140)) };
}
