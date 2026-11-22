"use strict";
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { paperMapTree } = loadReading("views/paper-discussion-map.ts");

const turns = [
	["a1", null, "a"], ["a2", "a1", "a"], ["b1", "a1", "b"], ["b2", "b1", "b"],
	["c1", "b2", "c"], ["d1", null, "d"], ["old1", null, "old"]
];
const session = {
	nodes: turns.map(([id, parentId, branchId]) => ({id, parentId, branchId, question:"相同的问题", content:"回答"})),
	branches: [
		{id:"b", parentNodeId:"a1", nodeIds:["b1", "b2"]},
		{id:"c", parentNodeId:"b2", nodeIds:["c1"]},
		{id:"a", annotation:{id:"quote-a"}, nodeIds:["a1", "a2"]},
		{id:"d", annotation:{id:"quote-d"}, nodeIds:["d1"]},
		{id:"old", annotation:{id:"outdated"}, nodeIds:["old1"]}
	]
};
const passages = [{id:"quote-a", order:90}, {id:"quote-d", order:12}];
const { roots, nodes } = paperMapTree(session, passages);
assert.deepEqual(roots.map(n => n.id), ["quote-d", "quote-a"]);
assert.deepEqual([nodes.get("quote-a").turns, nodes.get("quote-a").forks], [5, 2]);
assert.deepEqual([nodes.get("b1").turns, nodes.get("b1").forks], [3, 1]);
assert.deepEqual(nodes.get("a1").children.map(n => n.id), ["a2", "b1"]);
assert.equal(nodes.get("a2").parent.id, "a1");
assert.equal(nodes.get("b1").parent.id, "a1");
assert.equal(nodes.get("b2").parent.id, "b1");
assert.equal(nodes.get("c1").parent.id, "b2");
assert.equal(nodes.has("old1"), false);
assert.equal(nodes.get("d1").parent.id, "quote-d");
console.log("PAPER_DISCUSSION_MAP_OK");
