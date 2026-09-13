"use strict";
// Explicit development evaluation. This module never installs dependencies or reads secrets.
const fs = require("node:fs"), path = require("node:path");
const io = require("./reading-quality-io.cjs");
const active = new Map(), PROTOCOL = "rar-quality-run-1";
const fail = message => { throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validId = id => typeof id === "string" && /^[A-Z][0-9]{2}$/.test(id);
function endpoint(value) {
	const url = new URL(value);
	if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) fail("Use HTTPS or an explicitly configured loopback endpoint without embedded credentials");
	return url;
}
function profileInfo(profile, maxTokens = 2200) {
	if (profile.type !== "openai-compatible" || !profile.model?.trim() || !Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 4096) fail("This runner requires an explicit OpenAI-compatible profile and bounded output");
	endpoint(profile.baseUrl);
	return { id: profile.id, type: profile.type, model: profile.model, baseUrl: profile.baseUrl, vision: profile.capabilities?.vision === true, timeoutMs: 120000, maxTokens, streaming: false, webSearch: false, automaticRetries: 0 };
}
function loadPlan(directory, expectedHash) {
	const { planHash, ...plan } = JSON.parse(io.readFile(directory, "plan.json", 4 * 1024 * 1024));
	if (!/^[a-f0-9]{64}$/.test(expectedHash || "") || planHash !== expectedHash || io.sha(JSON.stringify(plan)) !== planHash || plan.schemaVersion !== 1 || plan.runnerProtocol !== PROTOCOL || plan.evaluationMode !== "fixed-evidence-qa" || typeof plan.sourceRoot !== "string" || !plan.sourceRoot || !Array.isArray(plan.inputs) || !plan.inputs.length || plan.inputs.length > 18 || !Array.isArray(plan.images) || plan.images.length > 64) fail("Frozen plan changed or unsupported");
	const ids = new Set();
	for (const q of plan.inputs) {
		const { inputHash, ...input } = q;
		if (!validId(q.id) || ids.has(q.id) || io.sha(JSON.stringify(input)) !== inputHash || typeof q.instructions !== "string" || !q.instructions || typeof q.prompt !== "string" || !Array.isArray(q.evidence) || !q.evidence.length || !Array.isArray(q.visuals) || Object.hasOwn(q, "expectedPoints") || Object.hasOwn(q, "mustNotClaim")) fail("Invalid model input or reference leakage");
		ids.add(q.id);
	}
	const files = new Set();
	for (const image of plan.images) {
		if (!/^images\/[a-f0-9]{64}\.(png|jpg)$/.test(image.file) || files.has(image.file) || !["image/png", "image/jpeg"].includes(image.mime) || !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > 16 * 1024 * 1024 || ![image.width, image.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16000) || image.width * image.height > 40000000) fail("Invalid decoded visual manifest");
		files.add(image.file);
	}
	return { ...plan, planHash };
}
function prepareRequest(input, images, read, profile) {
	const content = [{ type: "text", text: JSON.stringify({ id: input.id, question: input.prompt, primaryFormat: input.primaryFormat, evidence: input.evidence }) }], receipts = [];
	for (const visual of input.visuals) {
		if (!profile.vision) fail("Selected model profile does not support images");
		const matches = images.filter(i => i.kind === visual.kind && i.sourceFile === visual.sourceFile && i.sourceSha256 === visual.sourceSha256 && i.page === visual.page);
		if (matches.length !== 1) fail("Required visual was not uniquely prepared");
		const image = matches[0], bytes = read(image.file, image.bytes);
		if (bytes.length !== image.bytes || io.sha(bytes) !== image.sha256) fail("Prepared image changed");
		if (image.mime === "image/png" ? !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] !== 255 || bytes[1] !== 216) fail("Image format mismatch");
		content.push({ type: "text", text: `图像证据 ${visual.id}；${visual.kind === "pdf-page" ? "PDF 第 " + visual.page + " 页" : visual.sourceFile}` }, { type: "image_url", image_url: { url: `data:${image.mime};base64,${bytes.toString("base64")}`, detail: "high" } });
		receipts.push({ id: visual.id, sourceFile: visual.sourceFile, sourceSha256: visual.sourceSha256, ...(visual.page ? { page: visual.page } : {}), sha256: image.sha256, bytes: image.bytes, width: image.width, height: image.height, transform: image.transform });
	}
	const request = { model: profile.model, messages: [{ role: "system", content: input.instructions }, { role: "user", content }], maxTokens: profile.maxTokens };
	if (Buffer.byteLength(JSON.stringify(request)) > 24 * 1024 * 1024) fail("Request exceeds 24 MiB");
	return { request, visuals: receipts };
}
function usage(raw) {
	const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
	return { input: count(raw?.prompt_tokens), output: count(raw?.completion_tokens), total: count(raw?.total_tokens), cachedInput: count(raw?.prompt_tokens_details?.cached_tokens), monetaryCost: null, costStatus: "not_reported" };
}
function checkCitations(answer, input) {
	const known = new Set([...input.evidence, ...input.visuals].map(e => e.id));
	const mentioned = [...new Set(answer.match(/\b[A-Z]\d{2}-[EV]\d+\b/g) || [])];
	return { cited: mentioned.filter(id => known.has(id)), unknown: mentioned.filter(id => !known.has(id)), scientificSupport: "pending_independent_review" };
}
async function runCases({ plan, inputs, profile, execute, store, signal, mode = "live" }) {
	const records = []; let halted = false;
	for (const input of inputs) {
		if (signal.aborted || halted) break;
		if (!validId(input.id)) fail("Invalid question id");
		const prepared = store.prepare(input); // Validate every image before creating an attempt or contacting a provider.
		store.begin(input, prepared);
		let dispatched = false, responseReceived = false, wireHash = null, responseHash = null, cancelled = false;
		const start = Date.now(); let result;
		try {
			const answer = await execute(prepared.request, {
				signal,
				onRequest(wire) {
					const expected = { model: profile.model, messages: prepared.request.messages, max_tokens: profile.maxTokens, stream: false };
					if (dispatched || wire.method !== "POST" || endpoint(wire.url).origin !== endpoint(profile.baseUrl).origin || !wire.url.endsWith("/chat/completions") || !same(wire.body, expected)) fail("Provider changed the frozen request or attempted an extra call");
					wireHash = store.request(input.id, { url: wire.url, method: wire.method, body: wire.body });
					dispatched = true;
				},
				onResponse(response) {
					if (!dispatched || responseReceived || response.status < 200 || response.status >= 300 || typeof response.text !== "string" || Buffer.byteLength(response.text) > 5 * 1024 * 1024) fail("Unexpected response lifecycle");
					responseHash = store.response(input.id, response.text, response.status); responseReceived = true;
				}
			});
			if (!dispatched || !responseReceived) fail("Missing actual transport receipt");
			const finishReason = answer.raw?.choices?.[0]?.finish_reason ?? null;
			const state = signal.aborted ? "cancelled" : finishReason === "content_filter" || answer.raw?.choices?.[0]?.message?.refusal ? "refused" : finishReason === "length" ? "truncated" : !answer.text?.trim() ? "empty_answer" : "answered";
			result = { state, answer: answer.text || "", reportedModel: typeof answer.raw?.model === "string" ? answer.raw.model : null, finishReason, usage: usage(answer.raw?.usage), citations: checkCitations(answer.text || "", input) };
		} catch (error) {
			cancelled = signal.aborted;
			// Provider diagnostics may echo authorization headers. Keep only controlled type/status here.
			result = { state: cancelled ? "cancelled" : "failed", error: { type: typeof error.type === "string" && /^[a-z-]{1,40}$/.test(error.type) ? error.type : "execution", status: Number.isInteger(error.status) ? error.status : null, detail: "Request did not complete; no automatic retry. Inspect retained request/response if present." }, usage: usage(null) };
		}
		const record = { id: input.id, inputHash: input.inputHash, mode, ...result, elapsedMs: Date.now() - start, dispatched, responseReceived, requestHash: wireHash, responseHash,
			visuals: prepared.visuals.map(v => ({ ...v, transport: responseReceived ? "http_response_received" : dispatched ? "outcome_unknown" : "not_dispatched", modelVisualInspection: "not_verifiable" })), scientificReview: "pending" };
		store.result(record); records.push(record);
		halted = record.state !== "answered";
	}
	const summary = { protocol: PROTOCOL, planHash: plan.planHash, mode, profile, selected: inputs.map(i => i.id), recorded: records.length, answered: records.filter(r => r.state === "answered").length,
		state: signal.aborted ? "cancelled" : halted ? "stopped_after_failure" : "completed", remaining: inputs.slice(records.length).map(i => i.id), records: records.map(({ answer, ...record }) => record), scientificReview: "pending" };
	store.finish(summary); return summary;
}
function diskStore(directory, planDirectory, plan, profile) {
	return {
		prepare: input => prepareRequest(input, plan.images, (file, bytes) => io.readFile(planDirectory, file, bytes), profile),
		begin(input, prepared) { const folder = path.join(directory, input.id); fs.mkdirSync(folder); io.save(folder, "input.json", input); io.save(folder, "started.json", { startedAt: new Date().toISOString(), inputHash: input.inputHash, preparedImages: prepared.visuals }); },
		request: (id, wire) => io.save(path.join(directory, id), "request.json", wire),
		response(id, text, status) { const folder = path.join(directory, id), hash = io.save(folder, "response.txt", text, true); io.save(folder, "response-meta.json", { status, sha256: hash }); return hash; },
		result: record => io.save(path.join(directory, record.id), "result.json", record),
		finish: summary => io.save(directory, "summary.json", summary)
	};
}
function obsidianExecutor(plugin, selectedProfile, info) {
	return async (request, hooks) => {
		hooks.signal.throwIfAborted();
		const original = plugin.createLLMProvider({ ...selectedProfile, timeoutSeconds: info.timeoutMs / 1000 });
		const host = Object.create(plugin);
		host.providerHttpRequest = async options => {
			hooks.signal.throwIfAborted();
			hooks.onRequest({ url: options.url, method: options.method, body: options.body });
			const response = await plugin.providerHttpRequest(options);
			hooks.onResponse({ text: response.text, status: response.status }); return response;
		};
		const provider = new original.constructor(host, original.config);
		let cancel;
		const abort = () => cancel?.(); hooks.signal.addEventListener("abort", abort, { once: true });
		try { return await provider.complete(request, { timeoutMs: info.timeoutMs, registerCancel(fn) { cancel = fn; if (hooks.signal.aborted) fn(); } }); }
		finally { hooks.signal.removeEventListener("abort", abort); }
	};
}
function startInObsidian(app, { planDirectory, planHash, outputDirectory, profileId, questionIds, maxTokens = 2200 }) {
	if (active.size) fail("A quality run is already active in this module");
	const plugin = app.plugins.plugins["research-agent-reader"], selected = plugin?.getVerifiedProviderProfiles().find(p => p.id === profileId);
	if (!selected) fail("Select an already verified provider profile");
	const profile = profileInfo(selected, maxTokens), plan = loadPlan(planDirectory, planHash);
	if (!Array.isArray(questionIds) || !questionIds.length || questionIds.length > 18 || new Set(questionIds).size !== questionIds.length || questionIds.some(id => !plan.inputs.some(q => q.id === id))) fail("Select 1–18 distinct frozen questions");
	const inputs = questionIds.map(id => plan.inputs.find(q => q.id === id));
	// Preflight all selected visuals before any model call; in-flight reads recheck the same bytes.
	for (const input of inputs) prepareRequest(input, plan.images, (file, bytes) => io.readFile(planDirectory, file, bytes), profile);
	const directory = io.privateTarget(outputDirectory, [planDirectory, plan.sourceRoot, app.vault.adapter.getBasePath()]); fs.mkdirSync(directory);
	io.save(directory, "manifest.json", { protocol: PROTOCOL, mode: "live", planHash, baselineId: plan.baselineId, baselineHash: plan.baselineHash, instructionsHash: plan.instructionsHash,
		pluginVersion: plugin.manifest.version, runnerHash: io.sha(fs.readFileSync(__filename)), profile, questionIds, startedAt: new Date().toISOString(), independentReview: "pending" });
	const controller = new AbortController(); active.set(directory, controller);
	const store = diskStore(directory, planDirectory, plan, profile);
	runCases({ plan, inputs, profile, execute: obsidianExecutor(plugin, structuredClone(selected), profile), store, signal: controller.signal }).catch(() => {
		// A storage failure leaves started/request/response artifacts for inspection; never resubmit.
		try { io.save(directory, "interrupted.json", { state: "storage_or_preflight_failure", automaticRetry: false, scientificReview: "pending" }); } catch { /* Existing artifacts remain the recovery source. */ }
	}).finally(() => active.delete(directory));
	return { started: true, directory, model: profile.model, questions: questionIds, maximumCalls: questionIds.length };
}
function cancel(directory) { const controller = active.get(path.resolve(directory)); if (!controller) return false; controller.abort(); return true; }
function status(directory) {
	const manifest = JSON.parse(io.readFile(directory, "manifest.json"));
	const running = active.has(path.resolve(directory));
	return { running, questions: manifest.questionIds.map(id => ({ id, state: fs.existsSync(path.join(directory, id, "result.json")) ? JSON.parse(io.readFile(directory, id + "/result.json")).state : fs.existsSync(path.join(directory, id, "started.json")) ? running ? "running" : "incomplete_outcome_unknown" : "not_started" })), hasSummary: fs.existsSync(path.join(directory, "summary.json")) };
}
module.exports = { profileInfo, loadPlan, prepareRequest, usage, checkCitations, runCases, diskStore, obsidianExecutor, startInObsidian, cancel, status };
