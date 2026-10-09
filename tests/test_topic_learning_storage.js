"use strict";
// Only new isolated fixtures are created. All files are retained; no cleanup or deletion.
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadReading } = require("./reading-test-helpers");
const { FileSourceStorage } = loadReading("sources/storage.ts");
const { TopicSessionStore, TOPIC_DIRECTORY } = loadReading("topic-learning/store.ts");
const { TopicLearningService } = loadReading("topic-learning/service.ts");
const intent = { topic: "机器学习", goal: "理解训练集与测试集的区别", background: "" };
const plan = { version: 1, modules: [
	{ id: "unit-1", title: "数据与目标", question: "模型要预测什么？", objective: "能辨认输入与目标", prerequisites: [] },
	{ id: "unit-2", title: "训练与评估", question: "为什么要划分数据？", objective: "能解释独立测试数据的用途", prerequisites: ["unit-1"] },
] };
(async () => {
	if (process.argv[2] === "reload-probe") {
		const service = new TopicLearningService(new TopicSessionStore(new FileSourceStorage(process.argv[3])));
		const current = await service.get(process.argv[4], process.argv[5]);
		assert.deepEqual(current.session.intent, intent); assert.deepEqual(current.session.plan, plan); assert(current.session.confirmation);
		console.log("TOPIC_RESTART_OK"); return;
	}
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rar-topic-learning-")), io = new FileSourceStorage(root), store = new TopicSessionStore(io), service = new TopicLearningService(store);
	assert.deepEqual(await store.list(), []); assert.deepEqual(await fs.readdir(root), [], "read does not create directories");
	const initial = await service.create(intent), id = initial.session.id;
	const firstFile = path.join(root, TOPIC_DIRECTORY, id, initial.id + ".json"), firstBytes = await fs.readFile(firstFile);
	const edited = await service.editPlan(id, initial.digest, plan), confirmed = await service.confirmPlan(id, edited.digest);
	const restarted = execFileSync(process.execPath, [__filename, "reload-probe", root, id, confirmed.digest], { encoding: "utf8", windowsHide: true });
	assert(restarted.includes("TOPIC_RESTART_OK")); assert.deepEqual(await fs.readFile(firstFile), firstBytes);
	await assert.rejects(store.read("../outside"), /标识/);
	await assert.rejects(io.create(`${TOPIC_DIRECTORY}/${id}/${initial.id}.json`, Buffer.from("replacement")), /EEXIST/);
	// Simulate a crash before the ready marker; retain this incomplete attempt across restart.
	const pendingId = "v-" + require("node:crypto").randomUUID();
	await io.create(`${TOPIC_DIRECTORY}/${id}/${pendingId}.json`, Buffer.from("{partial"));
	const history = await new TopicSessionStore(new FileSourceStorage(root)).read(id);
	assert.equal(history.current.digest, confirmed.digest); assert.deepEqual(history.pending, [pendingId]); assert.deepEqual(history.errors, []);
	assert.deepEqual(await fs.readdir(root), [TOPIC_DIRECTORY], "topic writes stay outside document/history roots");
	assert.equal((await fs.readdir(path.join(root, TOPIC_DIRECTORY, id))).length, 7);
	console.log("TOPIC_STORAGE_OK: real exclusive writes, separate-process confirmed route recovery, retained partial attempt and original bytes; fixture retained at " + root);
})().catch(error => { console.error(error); process.exitCode = 1; });
