const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { CliTextService, resolveTextCliCommand } = loadReading("runtime/cli-text.ts");
const adapter = { label: "Fixture", invocation: (model, system) => ({ args: ["--model", model, "--system-prompt", system] }), parse: (stdout, requestedModel) => ({ text: JSON.parse(stdout).text, requestedModel }) };
const request = { executable: process.execPath, model: "Exact-Model", system: "只解释给定文字", user: "中文\n$() ` literal", timeoutMs: 2000 };
(async () => {
	let calls = 0, captured;
	const service = new CliTextService(async r => { calls++; captured = r; return { exitCode: 0, stdout: '{"text":"解释"}', stderr: "" }; });
	assert.equal((await service.generate(request, adapter, () => {})).text, "解释");
	assert.equal(captured.input, request.user); assert.deepEqual(captured.cliArgs, ["--model", "Exact-Model", "--system-prompt", request.system]);
	assert.ok(!captured.cwd.includes("paper-test")); assert.equal(calls, 1);
	await assert.rejects(service.generate(request, adapter, cancel => cancel()), /取消/); assert.equal(calls, 1);
	await assert.rejects(service.generate({ ...request, model: "" }, adapter, () => {}), /模型 ID/); assert.equal(calls, 1);
	for (const result of [{ exitCode: 1, stdout: "", stderr: "quota exhausted" }, { exitCode: 124, stdout: '{"text":"partial"}', stderr: "" }, { exitCode: 0, stdout: "invalid", stderr: "" }, { exitCode: 0, stdout: '{"text":""}', stderr: "" }]) {
		const failed = new CliTextService(async () => result);
		await assert.rejects(failed.generate(request, adapter, () => {}));
	}
	const pendingService = new CliTextService(r => new Promise(resolve => r.signal.addEventListener("abort", () => resolve({ exitCode: 130, stdout: "", stderr: "" }))));
	const pending = pendingService.generate(request, adapter, () => {}); const rejection = assert.rejects(pending, /取消/);
	await pendingService.dispose(); await rejection; await assert.rejects(pendingService.generate(request, adapter, () => {}), /取消/);
	// Exercise UTF-8 stdin and the actual native process controller without a model.
	const real = new CliTextService();
	const echo = { ...adapter, invocation: () => ({ args: ["-e", "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({text:s})))"] }) };
	assert.equal((await real.generate({ ...request, timeoutMs: 30000 }, echo, () => {})).text, request.user);
	const nullInput = { ...echo, input: () => null, invocation: () => ({ args: ["-e", "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.stdout.write(JSON.stringify({text:'null input EOF'})))"] }) };
	assert.equal((await real.generate({ ...request, timeoutMs: 30000 }, nullInput, () => {})).text, "null input EOF");
	const longArgs = { ...adapter, invocation: () => ({ args: ["-e", "process.stdout.write(JSON.stringify({text:process.argv[1]}))", "文".repeat(7000)] }) };
	assert.equal((await real.generate({ ...request, timeoutMs: 30000 }, longArgs, () => {})).text, "文".repeat(7000));
	const firstCwd = captured.cwd;
	await service.generate(request, adapter, () => {});
	assert.notEqual(captured.cwd, firstCwd, "requests cannot reuse prior launch/context files");
	const diagnostic = new CliTextService(async () => ({ exitCode: 1, stdout: JSON.stringify({ type: "error", error: { name: "ModelNotFound", data: { message: "Exact model unavailable" } } }), stderr: "#< CLIXML progress" }));
	await assert.rejects(diagnostic.generate(request, adapter, () => {}), /ModelNotFound: Exact model unavailable/);
	const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),root=fs.mkdtempSync(path.join(os.tmpdir(),"reader-scoop-fixture-"));
	const shim=path.join(root,"shims","opencode.exe"),native=path.join(root,"apps","opencode","1.0","opencode.exe");
	fs.mkdirSync(path.dirname(shim),{recursive:true});fs.mkdirSync(path.dirname(native),{recursive:true});fs.writeFileSync(shim,"");fs.writeFileSync(native,"");fs.writeFileSync(shim.replace(/\.exe$/,".shim"),`path = "${native}"`);
	assert.equal(resolveTextCliCommand(shim,{...adapter,binName:"opencode"}).command,fs.realpathSync(native));
	fs.writeFileSync(shim.replace(/\.exe$/,".shim"),`path = "${process.execPath}"`);
	assert.throws(()=>resolveTextCliCommand(shim,{...adapter,binName:"opencode"}),/入口未确认/);
	await real.dispose(); await service.dispose();
	console.log("CLI_TEXT_OK (exact args, UTF-8 stdin, failures, cancellation, disposal, native process)");
})().catch(error => { console.error(error); process.exitCode = 1; });
