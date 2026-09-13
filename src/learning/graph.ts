export interface LearningGraph { mainIds: string[]; branches: { id: string; parentNodeId: string; nodeIds: string[] }[]; collapsed: string[]; }
export interface LearningPosition { id: string; x: number; y: number; hiddenCount: number; }
export const LEARNING_MAP = { width: 224, height: 108, lane: 296, row: 164, inset: 44 };
/** Source-independent geometry, shared by document reading and topic study. */
export function layoutLearning(graph: LearningGraph): { nodes: LearningPosition[]; width: number; height: number } {
	const nodes: LearningPosition[] = [], positions = new Map<string, LearningPosition>(), occupied = new Set<string>();
	const add = (id: string, lane: number, row: number, hiddenCount = 0): void => {
		const node = { id, x: LEARNING_MAP.inset + lane * LEARNING_MAP.lane, y: LEARNING_MAP.inset + row * LEARNING_MAP.row, hiddenCount };
		nodes.push(node); positions.set(id, node); occupied.add(lane + ":" + row);
	};
	graph.mainIds.forEach((id, row) => add(id, 0, row));
	for (const branch of graph.branches) {
		const parent = positions.get(branch.parentNodeId); if (!parent || !branch.nodeIds.length) continue;
		const collapsed = graph.collapsed.includes(branch.id), ids = collapsed ? branch.nodeIds.slice(0, 1) : branch.nodeIds;
		const row = Math.round((parent.y - LEARNING_MAP.inset) / LEARNING_MAP.row);
		let lane = Math.round((parent.x - LEARNING_MAP.inset) / LEARNING_MAP.lane) + 1;
		while (ids.some((_, i) => occupied.has(lane + ":" + (row + i)))) lane++;
		ids.forEach((id, i) => add(id, lane, row + i, collapsed ? branch.nodeIds.length - 1 : 0));
	}
	return { nodes, width: Math.max(620, ...nodes.map(n => n.x + LEARNING_MAP.width + LEARNING_MAP.inset)), height: Math.max(480, ...nodes.map(n => n.y + LEARNING_MAP.height + 96)) };
}
export function learningAncestors<T extends { id: string; parentId: string | null }>(nodes: readonly T[], id: string | null): T[] {
	const result: T[] = [], seen = new Set<string>(), byId = new Map(nodes.map(n => [n.id, n]));
	while (id) { const node = byId.get(id); if (!node || seen.has(id)) throw new Error("学习节点关系缺失或存在循环"); seen.add(id); result.unshift(node); id = node.parentId; }
	return result;
}
