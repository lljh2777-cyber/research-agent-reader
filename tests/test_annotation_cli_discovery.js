const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { AnnotationCliDiscoveryService, parseAnnotationCliModels, parseQoderQuota, annotationCliControlInput } = loadReading("runtime/annotation-cli-discovery.ts");
const reply = (id, data, subtype = "success") => JSON.stringify({ type: "control_response", response: { request_id: id, subtype, response: data } });
const cb = reply("catalog-init", { models: [{ id: "step-5-preview", name: "Step-5-Preview" }, { id: "glm-5.3", name: "GLM-5.3" }] });
const qoder = "MODEL\nAuto\nQwen3.8-Flash\nQwen-3.8-Flash (11111111-2222-3333-4444-555555555555)\n";
const quota = remaining => reply("catalog-quota", { usage: { userId: "private-user", userQuota: { remaining, total: 300, unit: "credits" }, addOnQuota: { remaining: 700, unit: "credits" }, orgResourcePackage: { remaining: 800, unit: "credits", available: false } }, session: { total_credits: 99 } });
const success = stdout => ({ exitCode: 0, stdout, stderr: "" });
(async () => {
	assert.deepEqual(parseAnnotationCliModels("codebuddy", cb).map(m => m.id), ["step-5-preview", "glm-5.3"]);
	assert.throws(() => parseAnnotationCliModels("codebuddy", cb + "\n" + cb), /唯一/);
	assert.throws(() => parseAnnotationCliModels("codebuddy", reply("other", { models: [] })), /唯一/);
	assert.throws(() => parseAnnotationCliModels("codebuddy", reply("catalog-init", {}, "error")), /不支持/);
	assert.deepEqual(parseAnnotationCliModels("qoderclicn", qoder).map(m => m.id), ["Qwen3.8-Flash", "11111111-2222-3333-4444-555555555555"]);
	assert.throws(() => parseAnnotationCliModels("qoderclicn", "Login required"));
	assert.throws(() => parseAnnotationCliModels("qoderclicn", "MODEL\nUnknown table format"));
	assert.deepEqual(parseAnnotationCliModels("opencode", "opencode/mimo-v2.6-flash-free\nopencode/mimo-v2.6-flash-free\nother/exact-id\n").map(m => m.id), ["opencode/mimo-v2.6-flash-free", "other/exact-id"]);
	assert.equal(parseQoderQuota(quota(0)).buckets[0].remaining, 0, "zero is valid quota");
	assert.deepEqual(parseQoderQuota(quota(153)).buckets.map(b => b.remaining), [153, 700], "do not sum different quota buckets");
	assert.ok(!JSON.stringify(parseQoderQuota(quota(153))).includes("private-user"));
	for (const data of [{ session: { total_credits: 0 } }, { usage: { userQuota: { remaining: -1, unit: "credits" } } }, { usage: { userQuota: { used: 1, total: 100, unit: "credits" } } }, { usage: { userQuota: { remaining: "153", unit: "credits" } } }]) {
		assert.equal(parseQoderQuota(reply("catalog-quota", data)).status, "unknown", "missing/invalid remaining must not be inferred");
	}
	const messages = annotationCliControlInput(true).trim().split("\n").map(JSON.parse);
	assert.ok(messages.every(m => m.type === "control_request")); assert.equal(messages[0].request.hasPrompt, false);
	assert.equal(messages[1].request.subtype, "get_usage_info");
	const calls = []; let failQuota = false, failModels = false;
	const service = new AnnotationCliDiscoveryService(async r => {
		calls.push(r);
		assert.ok(!r.cwd.includes("paper-test"));
		if (r.input?.includes("catalog-quota")) return failQuota ? success(reply("catalog-quota", {}, "error")) : success(quota(153));
		if (failModels) return { exitCode: 1, stdout: "", stderr: "secret-token private-user" };
		return success(r.cliArgs.includes("--list-models") ? qoder : r.cliArgs.includes("models") ? "opencode/mimo-v2.6-flash-free" : cb);
	});
	assert.equal(service.get("qoderclicn", process.execPath), null);
	const pending = service.refresh("qoderclicn", process.execPath);
	assert.strictEqual(service.refresh("qoderclicn", process.execPath), pending, "coalesce concurrent refreshes");
	assert.equal(service.get("qoderclicn", process.execPath).status, "loading");
	const first = await pending; assert.equal(first.status, "ready"); assert.equal(first.quota.status, "known"); assert.equal(calls.length, 2);
	assert.equal(service.get("qoderclicn", process.execPath + "-different"), null, "path changes cannot reuse account snapshots");
	failQuota = true; const second = await service.refresh("qoderclicn", process.execPath);
	assert.equal(second.status, "ready"); assert.equal(second.quota.status, "unknown"); assert.deepEqual(second.quota.buckets, []);
	failQuota = false; failModels = true; const third = await service.refresh("qoderclicn", process.execPath);
	assert.equal(third.status, "error"); assert.equal(third.quota.status, "known"); assert.deepEqual(third.models, []); assert.ok(!third.message.includes("secret"));
	failModels = false;
	await service.refresh("codebuddy", process.execPath); await service.refresh("opencode", process.execPath);
	const oc = calls.find(c => c.cliArgs[0] === "models");
	assert.deepEqual(oc.cliArgs, ["models", "--pure", "--refresh"]); assert.equal(oc.input, null); assert.equal(oc.env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
	assert.equal(JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT).model, undefined, "listing models must not require an available generation model");
	for (const call of calls.filter(c => c.input)) {
		assert.ok(call.input.trim().split("\n").map(JSON.parse).every(m => m.type === "control_request"));
		assert.ok(!call.cliArgs.includes("--model"), "discovery must not pin a possibly retired model");
		assert.ok(call.cliArgs.includes("--no-session-persistence"));
		assert.equal(JSON.parse(call.cliArgs[call.cliArgs.indexOf("--settings") + 1]).disableAllHooks, true);
	}
	await service.dispose(); assert.equal(service.get("qoderclicn", process.execPath), null); await assert.rejects(service.refresh("codebuddy", process.execPath), /停止/);
	const cancelling = new AnnotationCliDiscoveryService(r => new Promise(resolve => r.signal.addEventListener("abort", () => resolve({ exitCode: 130, stdout: "", stderr: "" }))));
	const active = cancelling.refresh("qoderclicn", process.execPath); await cancelling.dispose(); await active;
	console.log("ANNOTATION_CLI_DISCOVERY_OK (exact IDs, no prompts, independent quota, unknown fallback, path isolation, refresh, cancellation)");
})().catch(error => { console.error(error); process.exitCode = 1; });
