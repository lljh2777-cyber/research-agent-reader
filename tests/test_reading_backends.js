const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { loadReading } = require("./reading-test-helpers");
let args; let prompt = "";
const { DirectReadingBackend, CodexReadingBackend, readingCodexArgs } = loadReading("reading/backend.ts", {
	"node:fs/promises": { mkdir: async () => {}, writeFile: async () => {} },
	"node:child_process": { spawn: (file, options) => {
		args = options; const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
		child.stdin.on("data", (chunk) => { prompt += chunk; }); child.stdin.on("finish", () => {
			child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "not answer" } }) + "\n");
			child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }) + "\n"); child.emit("close", 0);
		}); return child;
	} },
});
(async () => {
	let received; let timeout;
	const direct = new DirectReadingBackend({ capabilities: { vision: true }, complete: async (request, options) => { received = request; timeout = options.timeoutMs; return { text: "result" }; } }, "test", "model", false);
	const signal = new AbortController().signal;
	assert.equal(await direct.complete({ system: "rule", prompt: "question", images: [{ evidenceId: "p1", dataUrl: "data:image/png;base64,AA==" }], signal }), "result");
	assert.equal(received.messages[1].content[0].type, "image_url");
	assert.equal(timeout, 120000);
	const cli = new CodexReadingBackend("codex.exe", "test-model", "E:/plugin");
	assert.equal(await cli.complete({ system: "rule", prompt: "question", images: [], signal }), "answer");
	assert.match(prompt, /rule\n\nquestion/); assert.ok(args.includes("read-only")); assert.ok(args.includes("--ephemeral")); assert.equal(args.at(-1), "-");
	assert.ok(!readingCodexArgs("E:/x", "m", []).includes("--dangerously-bypass-approvals-and-sandbox"));
	console.log("READING_BACKENDS_OK");
})().catch((e) => { console.error(e); process.exitCode = 1; });
