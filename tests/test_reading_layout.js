const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { createReadingSession, addReadingNode, addReadingBranch } = loadReading("reading/session.ts");
const { layoutReading } = loadReading("reading/layout.ts");
const s = createReadingSession({ kind: "pdf", path: "a.pdf", fingerprint: "a".repeat(64), title: "test" });
for (let i = 0; i < 30; i++) { const node = addReadingNode(s, null); node.status = "done"; }
for (let i = 0; i < 27; i++) { const branch = addReadingBranch(s, s.mainIds[i]); for (let j = 0; j < 10; j++) { const node = addReadingNode(s, branch.id, "question"); node.status = "done"; } }
const layout = layoutReading(s); assert.equal(layout.nodes.length, 300);
assert.equal(new Set(layout.nodes.map((n) => n.x + ":" + n.y)).size, 300);
const positions = layout.nodes.slice(0, 30).map((n) => [n.x, n.y]);
s.ui.collapsed.push(s.branches[0].id); const collapsed = layoutReading(s);
assert.equal(collapsed.nodes.length, 291); assert.deepEqual(collapsed.nodes.slice(0, 30).map((n) => [n.x, n.y]), positions);
assert.equal(collapsed.nodes.find((n) => n.id === s.branches[0].nodeIds[0]).hiddenCount, 9);
console.log("READING_LAYOUT_OK");
