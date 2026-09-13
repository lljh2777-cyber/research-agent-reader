"use strict";
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { memory, request, controlledBackend, waitFor, candidate } = require("./fulltext-fixtures.cjs");
const { AcquisitionService } = loadReading("fulltext/service.ts");
const { AcquisitionRepository } = loadReading("fulltext/repository.ts");
const { parseAcquisitionInput, decodeJob, decodeRequest } = loadReading("fulltext/contracts.ts");
const { acquisitionTaskRun } = loadReading("fulltext/task-run.ts");
const services = [];
const make = (storage = memory(), backend = controlledBackend(), mode = "demo", device = "test-device") => { const service = new AcquisitionService(new AcquisitionRepository(storage, mode), device, backend); services.push(service); return { service, storage, backend }; };

(async () => {
	for (const [input, kind, value] of [[" DOI:10.1234/ABC ", "doi", "10.1234/abc"], ["https://doi.org/10.1234/A%2FB", "doi", "10.1234/a/b"], ["https://pubmed.ncbi.nlm.nih.gov/123/", "pmid", "123"], ["https://pmc.ncbi.nlm.nih.gov/articles/PMC123/", "pmcid", "PMC123"], ["pmcid: pmc123", "pmcid", "PMC123"], ["123", "pmid", "123"]]) assert.deepEqual(parseAcquisitionInput(input), { kind, value });
	for (const input of ["", "0", "https://example.org/10.1234/a", "https://user:pass@doi.org/10.1234/a", "https://doi.org:9000/10.1234/a", "10.1234/a b", "PMC0", "10.1234/<a>"]) assert.throws(() => parseAcquisitionInput(input));
	assert.throws(() => decodeRequest(request(), "production"));
	for (const input of [
		"https://www.nature.com/articles/s41592-026-03217-4",
		"https://nature.com/articles/s41592-026-03217-4/",
		"https://www.nature.com/articles/s41592-026-03217-4.pdf?download=1#citeas",
		"https://www.nature.com/articles/s41592-026-03217-4?utm_source=test#Fig1",
	]) assert.deepEqual(parseAcquisitionInput(input), { kind: "doi", value: "10.1038/s41592-026-03217-4" });
	assert.deepEqual(parseAcquisitionInput("https://www.nature.com/articles/nature12373"), { kind: "doi", value: "10.1038/nature12373" });
	for (const input of [
		"https://www.nature.com/", "https://www.nature.com/articles/", "https://www.nature.com/articles/a/b",
		"https://www.nature.com/articles/s41592-026-03217-4/figures/1", "https://www.nature.com/articles/%2Fetc",
		"https://www.nature.com.evil.example/articles/s41592-026-03217-4", "https://evil.example/?url=https://www.nature.com/articles/s41592-026-03217-4",
		"https://user:password@www.nature.com/articles/s41592-026-03217-4", "https://www.nature.com:9000/articles/s41592-026-03217-4",
	]) assert.throws(() => parseAcquisitionInput(input));
	assert.throws(() => parseAcquisitionInput("https://example.org/article"), /暂不支持.*请粘贴.*DOI/);
	assert.throws(() => make(memory(), controlledBackend(), "production"), /演示/);

	const a = make(), states = []; const unsubscribe = a.service.subscribe(() => states.push(a.service.list()[0]?.phase));
	const [first, duplicate] = await Promise.all([a.service.start(request()), a.service.start(request())]);
	assert.equal(first.id, duplicate.id); await waitFor(() => a.backend.downloads.length === 1); assert.equal(a.backend.calls, 1);
	const dl = a.backend.downloads[0], writes = a.storage.writes;
	for (let i = 1; i <= 1000; i++) dl.progress(i, 2000);
	dl.progress(5, 2000); dl.progress(2500, 2000); dl.progress(NaN); dl.progress(1500, 1999);
	assert.equal(a.service.get(first.id).receivedBytes, 1000); assert.equal(a.storage.writes, writes, "byte events must not write records");
	assert.equal(a.service.stop(first.id), true); await waitFor(() => a.service.get(first.id).phase === "cancelled");
	await a.service.retry(first.id); await waitFor(() => a.backend.downloads.length === 2);
	const secondAttempt = a.service.get(first.id).attemptId; assert.notEqual(first.attemptId, secondAttempt);
	dl.progress(2000, 2000); dl.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(a.service.get(first.id).phase, "downloading"); assert.equal(a.service.get(first.id).receivedBytes, undefined);
	a.backend.downloads[1].progress(2000, 2000); a.backend.downloads[1].resolve(); await waitFor(() => a.service.get(first.id).phase === "acquired");
	assert.equal(a.storage.snapshots.size, 1); assert.equal(a.service.stop(first.id), false); assert.throws(() => acquisitionTaskRun(a.service.get(first.id)));
	assert.ok(states.includes("verifying")); unsubscribe();
	const reopened = make(a.storage); await reopened.service.ready(); assert.equal(reopened.service.get(first.id).phase, "acquired"); assert.equal(reopened.backend.calls, 0);

	const selection = make(), choice = await selection.service.start(request("selection"));
	await waitFor(() => selection.service.get(choice.id).phase === "awaiting_selection");
	await assert.rejects(selection.service.choose(choice.id, "c-missing"));
	const choices = await Promise.allSettled([selection.service.choose(choice.id, "c-two"), selection.service.choose(choice.id, "c-one")]);
	assert.equal(choices.filter(r => r.status === "fulfilled").length, 1); await waitFor(() => selection.backend.downloads.length === 1);
	assert.equal(selection.backend.downloads[0].candidate.id, "c-two"); selection.service.stop(choice.id); await selection.service.settled();

	for (const scenario of ["failure", "conflict", "no_match"]) {
		const fixture = make(), job = await fixture.service.start(request(scenario));
		if (scenario === "conflict") { await waitFor(() => fixture.backend.downloads.length); fixture.backend.downloads[0].resolve(); }
		await waitFor(() => fixture.service.get(job.id).phase === (scenario === "failure" ? "failed" : scenario)); assert.equal(fixture.storage.snapshots.size, 0);
	}
	const initial = make(); initial.storage.failJob = () => true;
	await assert.rejects(initial.service.start(request()), /无法保存/); assert.equal(initial.backend.calls, 0); assert.equal(initial.service.list().length, 0);
	const stageFailure = make(); stageFailure.storage.failJob = job => job.phase === "discovering";
	const stageJob = await stageFailure.service.start(request()); await waitFor(() => stageFailure.service.get(stageJob.id).storageWarning);
	assert.equal(stageFailure.service.get(stageJob.id).phase, "failed"); assert.equal(stageFailure.backend.downloads.length, 0);
	stageFailure.storage.failJob = null; await stageFailure.service.retry(stageJob.id); await waitFor(() => stageFailure.backend.downloads.length); stageFailure.service.stop(stageJob.id); await stageFailure.service.settled();
	const snapshotFailure = make(), failedSnapshot = await snapshotFailure.service.start(request()); snapshotFailure.storage.failSnapshot = true;
	await waitFor(() => snapshotFailure.backend.downloads.length); snapshotFailure.backend.downloads[0].resolve(); await waitFor(() => snapshotFailure.service.get(failedSnapshot.id).phase === "failed"); assert.equal(snapshotFailure.storage.snapshots.size, 0);

	const commitFailure = make(), committed = await commitFailure.service.start(request());
	commitFailure.storage.failJob = job => job.phase === "acquired";
	await waitFor(() => commitFailure.backend.downloads.length); commitFailure.backend.downloads[0].resolve(); await waitFor(() => commitFailure.service.get(committed.id).storageWarning);
	assert.equal(commitFailure.storage.snapshots.size, 1); assert.equal(commitFailure.service.get(committed.id).phase, "failed");
	commitFailure.storage.failJob = null;
	const recovered = make(commitFailure.storage); await recovered.service.ready(); assert.equal(recovered.service.get(committed.id).phase, "acquired"); assert.equal(recovered.backend.calls, 0);
	const receipt = [...commitFailure.storage.snapshots.values()][0]; receipt.candidateId = "c-mismatch";
	const invalidReceipt = make(commitFailure.storage); await invalidReceipt.service.ready(); assert.equal(invalidReceipt.service.get(committed.id).phase, "interrupted");

	const interrupt = make(), running = await interrupt.service.start(request()); await waitFor(() => interrupt.backend.downloads.length);
	const remote = make(interrupt.storage, controlledBackend(), "demo", "other-device"); await remote.service.ready();
	assert.equal(remote.service.get(running.id).phase, "downloading"); assert.equal(remote.service.stop(running.id), false); await assert.rejects(remote.service.retry(running.id));
	await interrupt.service.dispose(); assert.equal(interrupt.storage.jobs.get(running.id).phase, "interrupted");
	interrupt.backend.downloads[0].resolve(); await new Promise(r => setTimeout(r, 10)); assert.equal(interrupt.storage.snapshots.size, 0);
	const restored = make(interrupt.storage); await restored.service.ready(); assert.equal(restored.service.get(running.id).phase, "interrupted"); assert.equal(restored.backend.calls, 0);
	const crash = make(interrupt.storage); interrupt.storage.jobs.set(running.id, { ...interrupt.storage.jobs.get(running.id), phase: "awaiting_selection", candidates: [candidate()], selectedId: undefined });
	await crash.service.ready(); assert.equal(crash.service.get(running.id).phase, "interrupted"); assert.equal(crash.backend.calls, 0, "crash recovery never automatically starts a provider");
	const committing = make(); let releaseCommit, commitEntered = false;
	committing.storage.writeSnapshot = async function(snapshot) { commitEntered = true; await new Promise(resolve => { releaseCommit = resolve; }); this.snapshots.set(snapshot.id, structuredClone(snapshot)); };
	const committingJob = await committing.service.start(request()); await waitFor(() => committing.backend.downloads.length); committing.backend.downloads[0].resolve(); await waitFor(() => commitEntered);
	assert.equal(committing.service.stop(committingJob.id), false, "stop must not claim to cancel a commit already in progress"); releaseCommit(); await waitFor(() => committing.service.get(committingJob.id).phase === "acquired");
	const verifying = make(); let releaseVerify; verifying.backend.verify = async () => new Promise(resolve => { releaseVerify = resolve; });
	const verifyingJob = await verifying.service.start(request()); await waitFor(() => verifying.backend.downloads.length); verifying.backend.downloads[0].resolve(); await waitFor(() => releaseVerify);
	assert.equal(verifying.service.stop(verifyingJob.id), true); await verifying.service.settled(); releaseVerify("valid"); await new Promise(r => setTimeout(r, 10));
	assert.equal(verifying.storage.snapshots.size, 0); assert.equal(verifying.service.get(verifyingJob.id).phase, "cancelled");
	const corrupted = make(); corrupted.storage.jobs.set(running.id, { ...running, revision: -1 }); await corrupted.service.ready(); assert.equal(corrupted.service.list().length, 0); assert.equal(corrupted.service.diagnostics.length, 1);
	assert.throws(() => decodeJob({ ...running, id: "../../unsafe" }, "demo"));
	assert.throws(() => decodeJob({ ...running, phase: "acquired" }, "demo"));

	const productionStorage = memory(), production = new AcquisitionService(new AcquisitionRepository(productionStorage, "production"), "test-device"); services.push(production);
	const productionRequest = request(); delete productionRequest.scenario;
	const unavailable = await production.start(productionRequest); assert.equal(unavailable.phase, "needs_configuration");
	const task = acquisitionTaskRun(unavailable); assert.equal(task.actionId, "fulltext-acquisition"); assert.equal(task.executionConfig, null); assert.equal(task.status, "failed");
	await assert.rejects(production.repository.saveSnapshot(receipt), /演示/);

	// TaskRun integration projects sidecars without invoking settings writes or retention.
	class Base {}
	const obsidian = { Plugin: Base, PluginSettingTab: Base, Component: Base, ItemView: Base, Modal: Base, TFile: Base, FileSystemAdapter: Base, Notice: Base };
	const Plugin = loadReading("plugin.ts", { obsidian, electron: {} }).default;
	const plugin = new Plugin(); plugin.acquisitionServices.set("production", production); plugin.acquisitionServices.set("demo", a.service);
	plugin.saveSettings = async () => { throw new Error("must not save settings"); };
	assert.equal(plugin.getTaskRuns().length, 1); assert.equal(plugin.getTaskRun(unavailable.id).summary, productionRequest.input.value); assert.equal(plugin.getTaskRun(first.id), null);
	production.repository.jobs.set(unavailable.id, { ...unavailable, phase: "downloading" });
	assert.equal(plugin.isActionRunning("fulltext-acquisition"), true); assert.equal(plugin.getRunningTaskRun("fulltext-acquisition").id, unavailable.id);
	production.repository.jobs.set(unavailable.id, { ...unavailable, phase: "downloading", deviceId: "another-device" }); assert.equal(plugin.isActionRunning("fulltext-acquisition"), false);
	production.repository.jobs.set(unavailable.id, unavailable);
	plugin.taskRuns = [{ ...task, id: "orphan-task-summary", status: "running" }]; assert.equal(plugin.isActionRunning("fulltext-acquisition"), false, "a summary without its acquisition record cannot own execution"); plugin.taskRuns = [];
	const { DashboardView } = loadReading("views/dashboard.ts", { obsidian });
	const view = Object.create(DashboardView.prototype); let opened = 0;
	view.plugin = { openFulltextAcquisition() { opened++; } };
	view.openAction({ id: "fulltext-acquisition", enabled: true }); view.openTaskResult(task); assert.equal(opened, 2);
	console.log("PASS fulltext: canonical input, isolation, deduplication, progress, late events, selection, retries, persistence failures, receipt recovery, device ownership, disposal and TaskRun routing");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await Promise.all(services.map(service => service.dispose())); });
