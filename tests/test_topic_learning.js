"use strict";
// All fixtures in memory. No files, network, live model calls or cleanup.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { createTopicSession, validateTopicSession, validateTopicIntent, validateTopicPlan, topicDigest } = loadReading("topic-learning/contracts.ts");
const { TopicSessionStore, TOPIC_DIRECTORY } = loadReading("topic-learning/store.ts");
const { TopicLearningService } = loadReading("topic-learning/service.ts");
const { validateReadingSession, createReadingSession } = loadReading("reading/session.ts");
const { validateModulePlan } = loadReading("reading/planning.ts");
const { readPaperLibrary } = loadReading("library/reader.ts");
const intent = { topic: "神经网络", goal: "理解损失函数与梯度下降的作用", background: "会 Python，尚未系统学习微积分" };
const plan = { version: 1, modules: [
	{ id: "unit-1", title: "从预测到误差", question: "怎样衡量预测偏差？", objective: "能区分预测值、真实值和损失", prerequisites: [] },
	{ id: "unit-2", title: "优化与回顾", question: "参数更新怎样影响损失？", objective: "能描述梯度下降的更新方向与学习率作用", prerequisites: ["unit-1"] },
] };
function memoryIO() {
	const files = new Map(), directories = new Set(), operations = [];
	return { files, directories, operations,
		async read(name) { operations.push(["read", name]); return files.has(name) ? Buffer.from(files.get(name)) : null; },
		async list(root) { operations.push(["list", root]); const prefix = root + "/", found = new Map();
			for (const name of [...directories, ...files.keys()]) if (name.startsWith(prefix) && !name.slice(prefix.length).includes("/")) found.set(name.slice(prefix.length), directories.has(name));
			return [...found].map(([name, directory]) => ({ name, directory })); },
		async mkdir(name) { operations.push(["mkdir", name]); directories.add(name); },
		async create(name, bytes) { operations.push(["create", name]); assert(!files.has(name), "must never replace a saved file"); files.set(name, Buffer.from(bytes)); },
	};
}
const mock = (complete = async () => JSON.stringify(plan)) => ({ name: "mock", model: "test-model", images: false, complete });
async function fixture() {
	const io = memoryIO(), store = new TopicSessionStore(io), service = new TopicLearningService(store), initial = await service.create(intent);
	return { io, store, service, initial, id: initial.session.id };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

(async () => {
	// Source-free identity, strict separation from all existing reading modes.
	const session = createTopicSession(intent);
	assert.deepEqual(validateTopicSession(JSON.parse(JSON.stringify(session))), session);
	assert(!("source" in session)); assert(!("paperId" in session)); assert(!("completed" in session));
	assert.throws(() => validateReadingSession(session));
	assert.throws(() => validateTopicSession(createReadingSession({ kind: "pdf", path: "a.pdf", title: "paper", fingerprint: "a".repeat(64) })));
	for (const field of ["source", "paperId", "evidenceIds", "depth", "completed", "learningState"]) assert.throws(() => validateTopicSession({ ...session, [field]: "invented" }));
	assert.throws(() => validateTopicSession({ ...session, evidencePolicy: "paper" }));
	assert.throws(() => validateTopicSession({ ...session, plan, planOrigin: { kind: "vault" } }));
	assert.throws(() => validateTopicIntent({ ...intent, topic: " " }));
	assert.throws(() => validateTopicIntent({ ...intent, goal: "a".repeat(2001) }));
	assert.deepEqual(validateTopicIntent({ ...intent, background: "" }).background, "");
	assert.equal(topicDigest({ b: 1, a: 2 }), topicDigest({ a: 2, b: 1 }));
	// Route validation enforces real prerequisites, no cycles or invented evidence fields.
	assert.deepEqual(validateTopicPlan(plan), plan);
	for (const modules of [[], [plan.modules[0]], Array(13).fill(plan.modules[0]), [plan.modules[0], plan.modules[0]],
		[{ ...plan.modules[0], prerequisites: ["unit-2"] }, plan.modules[1]],
		[plan.modules[0], { ...plan.modules[1], prerequisites: ["unit-2"] }],
		[plan.modules[0], { ...plan.modules[1], prerequisites: ["unit-1", "unit-1"] }],
		[plan.modules[0], { ...plan.modules[1], objective: "" }],
		[plan.modules[0], { ...plan.modules[1], evidenceIds: ["fake"] }]]) assert.throws(() => validateTopicPlan({ version: 1, modules }));
	assert.throws(() => validateModulePlan({ version: 1, modules: plan.modules.map(m => ({ title: m.title, question: m.question, evidenceIds: [] })) }), /证据/);
	// Read and create do not call a backend, read does not write or initialize storage.
	{
		const io = memoryIO(), store = new TopicSessionStore(io);
		assert.deepEqual(await store.list(), []); assert.equal((await store.read(session.id)).current, undefined);
		assert(io.operations.every(([kind]) => ["list", "read"].includes(kind)));
	}
	{
		const f = await fixture(), start = f.io.operations.length;
		const library = await readPaperLibrary(memoryIO(), f.io, { vaultRoot: require("node:path").resolve("memory-empty-vault"), parseYaml: JSON.parse });
		assert.equal(library.papers.length, 0); assert.equal(library.readIssues.length, 0);
		assert(f.io.operations.slice(start).every(([kind, name]) => ["read", "list"].includes(kind) && !name.startsWith(TOPIC_DIRECTORY)));
	}
	// Explicit single model request; durable draft, user confirmation, editing, reload and stale receipts.
	{
		const f = await fixture(); let calls = 0;
		const result = await f.service.plan(f.id, f.initial.digest, mock(async request => {
			calls++; assert.deepEqual(request.images, []); assert.equal(request.webSearch, undefined);
			assert(!("evidenceIds" in request.schema.properties.modules.items.properties));
			assert.deepEqual(JSON.parse(request.prompt), { action: "规划主题学习路线", ...intent });
			assert.match(request.system, /未读取知识库/); assert.match(request.system, /不代表用户已掌握/);
			return "```json\n" + JSON.stringify(plan) + "\n```";
		}));
		assert.equal(calls, 1); assert.deepEqual(result.session.plan, plan); assert.equal(result.session.confirmation, undefined);
		assert.deepEqual(result.session.planOrigin, { kind: "model-knowledge", provider: "mock", model: "test-model" });
		const confirmed = await f.service.confirmPlan(f.id, result.digest);
		assert(confirmed.session.confirmation); assert(!("completed" in confirmed.session));
		const snapshot = [...f.io.files].map(([name, bytes]) => [name, bytes.toString()]);
		const fresh = new TopicLearningService(new TopicSessionStore(f.io));
		assert.deepEqual(await fresh.get(f.id), confirmed); assert.deepEqual(await fresh.store.list(), [f.id]);
		assert.deepEqual([...f.io.files].map(([name, bytes]) => [name, bytes.toString()]), snapshot);
		assert.equal((await fresh.confirmPlan(f.id, confirmed.digest)).digest, confirmed.digest);
		await assert.rejects(fresh.plan(f.id, confirmed.digest, mock()), /已经确认/);
		await assert.rejects(fresh.editIntent(f.id, result.digest, { ...intent, goal: "changed" }), /已变化/);
		const editedPlan = structuredClone(plan); editedPlan.modules[1].objective = "能手算一轮简单的参数更新";
		const edited = await fresh.editPlan(f.id, confirmed.digest, editedPlan);
		assert.equal(edited.session.confirmation, undefined); assert.equal(edited.session.planOrigin.kind, "user");
		const changed = await fresh.editIntent(f.id, edited.digest, { ...intent, goal: "学习卷积网络" });
		assert.equal(changed.session.plan, undefined); assert.equal(changed.session.planOrigin, undefined);
		assert.equal((await fresh.store.read(f.id)).revisions.length, 5);
		for (const [name, bytes] of snapshot) assert.equal(f.io.files.get(name).toString(), bytes, "old histories retained");
		assert.throws(() => validateTopicSession({ ...confirmed.session, intent: { ...intent, goal: "tampered" } }), /发生变化/);
		assert([...f.io.files.keys()].every(name => name.startsWith(TOPIC_DIRECTORY + "/")));
	}
	// Invalid output/provider failure never replaces a route; there is no automatic retry.
	for (const response of ["not json", JSON.stringify({ ...plan, completed: true }), JSON.stringify({ version: 1, modules: [] }), "x".repeat(100001), null]) {
		const f = await fixture(); let calls = 0;
		await assert.rejects(f.service.plan(f.id, f.initial.digest, mock(async () => { calls++; if (response === null) throw new Error("provider failed"); return response; })));
		assert.equal(calls, 1); assert.equal((await f.service.get(f.id)).digest, f.initial.digest);
		await f.service.plan(f.id, f.initial.digest, mock()); // Explicit retry is possible.
	}
	// Late responses cannot overwrite edited goals; duplicate clicks don't issue a second request.
	{
		const f = await fixture(), entered = deferred(), answer = deferred(); let calls = 0;
		const running = f.service.plan(f.id, f.initial.digest, mock(async () => { calls++; entered.resolve(); return answer.promise; }));
		await entered.promise;
		await assert.rejects(f.service.plan(f.id, f.initial.digest, mock()), /正在生成/);
		const changed = await f.service.editIntent(f.id, f.initial.digest, { ...intent, goal: "新目标" });
		answer.resolve(JSON.stringify(plan)); await assert.rejects(running, /已变化/);
		assert.equal(calls, 1); assert.equal((await f.service.get(f.id)).digest, changed.digest);
	}
	// Both cancellation mechanisms and shutdown discard even an uncooperative backend's late result.
	for (const mode of ["external", "cancel", "dispose", "pre-aborted"]) {
		const f = await fixture(), entered = deferred(), answer = deferred(), controller = new AbortController(); let calls = 0;
		if (mode === "pre-aborted") controller.abort();
		const running = f.service.plan(f.id, f.initial.digest, mock(async () => { calls++; entered.resolve(); return answer.promise; }), controller.signal);
		const rejected = assert.rejects(running);
		if (mode !== "pre-aborted") { await entered.promise; if (mode === "external") controller.abort(); else if (mode === "cancel") f.service.cancel(f.id); else f.service.dispose(); }
		await rejected; answer.resolve(JSON.stringify(plan)); await new Promise(resolve => setImmediate(resolve));
		assert.equal(calls, mode === "pre-aborted" ? 0 : 1); assert.equal((await f.service.get(f.id)).digest, f.initial.digest);
	}
	// The request timeout discards late output without a real three-minute wait.
	{
		const f = await fixture(), entered = deferred(), answer = deferred();
		const originalTimer = global.setTimeout; let timeout;
		global.setTimeout = (callback, ms, ...args) => {
			if (ms === 180000) { timeout = callback; return undefined; }
			return originalTimer(callback, ms, ...args);
		};
		try {
			const running = f.service.plan(f.id, f.initial.digest, mock(async () => { entered.resolve(); return answer.promise; }));
			const rejected = assert.rejects(running, /超过 3 分钟/);
			await entered.promise; assert.equal(typeof timeout, "function"); timeout(); await rejected;
			answer.resolve(JSON.stringify(plan)); await new Promise(resolve => setImmediate(resolve));
			assert.equal((await f.service.get(f.id)).digest, f.initial.digest);
		} finally { global.setTimeout = originalTimer; }
	}
	// Partial writes are retained and excluded; manual retry works, including cancellation before publication.
	for (const failure of ["body", "marker", "cancel"]) {
		const f = await fixture(), create = f.io.create.bind(f.io); let fail = true;
		f.io.create = async (name, bytes) => {
			if (fail && ((failure === "body" && name.endsWith(".json")) || (failure === "marker" && name.endsWith(".ready")))) { fail = false; throw new Error("disk full"); }
			await create(name, bytes);
			if (fail && failure === "cancel" && name.endsWith(".json")) { fail = false; f.service.cancel(f.id); }
		};
		await assert.rejects(f.service.plan(f.id, f.initial.digest, mock()));
		assert.equal((await f.service.get(f.id)).digest, f.initial.digest);
		assert.equal((await f.store.read(f.id)).pending.length, failure === "body" ? 0 : 1);
		await f.service.plan(f.id, f.initial.digest, mock());
	}
	// Missing committed content, mismatched IDs, corrupted JSON and digest tampering fail closed, without repair writes.
	for (const mode of ["missing", "id", "json", "digest"]) {
		const f = await fixture(), name = `${TOPIC_DIRECTORY}/${f.id}/${f.initial.id}.json`, read = f.io.read.bind(f.io);
		f.io.read = async file => {
			const bytes = await read(file); if (file !== name) return bytes;
			if (mode === "missing") return null; if (mode === "json") return Buffer.from("{");
			const value = JSON.parse(bytes); if (mode === "id") value.session.id = createTopicSession(intent).id; else value.session.intent.goal = "tampered";
			return Buffer.from(JSON.stringify(value));
		};
		const before = f.io.operations.length; assert((await f.store.read(f.id)).errors.length); await assert.rejects(f.service.get(f.id));
		await assert.rejects(f.service.confirmPlan(f.id, f.initial.digest));
		assert(f.io.operations.slice(before).every(([kind]) => ["list", "read"].includes(kind)));
	}
	// Racing writers retain both versions and surface a conflict, never pick a winner by timestamp.
	{
		const f = await fixture(), create = f.io.create.bind(f.io), barrier = deferred(); let bodies = 0;
		f.io.create = async (name, bytes) => { await create(name, bytes); if (name.endsWith(".json")) { if (++bodies === 2) barrier.resolve(); await barrier.promise; } };
		const other = new TopicLearningService(new TopicSessionStore(f.io));
		const results = await Promise.allSettled([f.service.editIntent(f.id, f.initial.digest, { ...intent, goal: "first" }), other.editIntent(f.id, f.initial.digest, { ...intent, goal: "second" })]);
		assert(results.some(result => result.status === "rejected"));
		const history = await f.store.read(f.id); assert.equal(history.revisions.length, 3); assert.equal(history.current, undefined); assert(history.errors.some(error => error.includes("并发")));
	}
	console.log("TOPIC_LEARNING_OK: source-free contracts, explicit planning/confirmation, reload, stale edits, cancellation, write failures, corruption and concurrent history isolation");
})().catch(error => { console.error(error); process.exitCode = 1; });
