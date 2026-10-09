"use strict";
// Memory-only targeted coverage for the intake loop; deliberately excludes legacy disk-cleanup tests.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { ToolFailureGuard, toolRequestKey } = loadReading("agent/tool-feedback.ts");
const { runBoundedAgentLoop } = loadReading("agent/loop.ts");
(async () => {
	assert.equal(toolRequestKey("read", { b: 2, a: { d: 4, c: 3 } }), toolRequestKey("read", { a: { c: 3, d: 4 }, b: 2 }));
	const guard = new ToolFailureGuard(); assert.equal(guard.failed("read", { a: 1 }), false); guard.succeeded("read", { a: 1 }); assert.equal(guard.failed("read", { a: 1 }), false);
	for (const unknown of [false, true]) {
		let count = 0;
		const result = await runBoundedAgentLoop({ system: "test", user: "test", model: "mock", tools: unknown ? [] : [{ name: "read", description: "read", parameters: {}, execute: async () => { throw new Error("invalid target"); } }],
			provider: { complete: async () => ({ text: JSON.stringify({ action: "tool", tool: "read", arguments: ++count === 1 ? { a: 1, b: 2 } : { b: 2, a: 1 } }) }) } });
		assert.equal(result.status, "failed"); assert.match(result.error, /重复提交/); assert.equal(count, 2); assert.equal(result.toolCalls.length, unknown ? 0 : 2);
	}
	let turn = 0;
	const corrected = await runBoundedAgentLoop({ system: "test", user: "test", model: "mock", tools: [{ name: "read", description: "read", parameters: { id: "string" }, execute: async args => { if (args.id !== "valid") throw new Error("use valid"); return { output: "evidence", receiptData: { paths: ["wiki/sources/a.md"] } }; } }],
		provider: { complete: async () => ({ text: JSON.stringify(++turn < 3 ? { action: "tool", tool: "read", arguments: { id: turn === 1 ? "bad" : "valid" } } : { action: "final", result: { status: "done" } }) }) } });
	assert.equal(corrected.status, "completed"); assert.equal(turn, 3); assert.deepEqual(corrected.toolCalls.map(c => c.ok), [false, true]); assert.deepEqual(corrected.toolCalls[1].data.paths, ["wiki/sources/a.md"]);
	console.log("AGENT_FEEDBACK_OK: shared retry guard, argument order, recovery, intake receipts");
})().catch(error => { console.error(error); process.exitCode = 1; });
