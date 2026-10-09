// Pure memory fixtures shared by service and native Obsidian checks. No filesystem cleanup.
const { setTimeout } = require("node:timers");
exports.memory = () => ({
	jobs: new Map(), snapshots: new Map(), writes: 0, failJob: null, failSnapshot: false,
	async listJobs() { return [...this.jobs.keys()]; },
	async readJob(id) { return structuredClone(this.jobs.get(id)); },
	async writeJob(job) { this.writes++; if (this.failJob?.(job)) throw new Error("disk full"); this.jobs.set(job.id, structuredClone(job)); },
	async readSnapshot(id) { return structuredClone(this.snapshots.get(id)); },
	async writeSnapshot(snapshot) { if (this.failSnapshot) throw new Error("disk full"); this.snapshots.set(snapshot.id, structuredClone(snapshot)); },
});
exports.request = scenario => ({ input: { kind: "doi", value: "10.0000/fulltext-demo" }, goal: "pdf", versionPolicy: "record_only", scenario: scenario || "success" });
exports.candidate = id => ({ id: id || "c-one", title: "全文获取流程示例（虚构）", providerId: "demo", version: "version_of_record" });
exports.controlledBackend = () => ({
	mode: "demo", calls: 0, downloads: [], scenario: "success",
	async resolve() { this.calls++; },
	async discover(request) { if (request.scenario === "failure") throw new Error("failed"); return request.scenario === "no_match" ? [] : request.scenario === "selection" ? [exports.candidate(), exports.candidate("c-two")] : [exports.candidate()]; },
	async download(candidate, signal, progress) { return new Promise((resolve, reject) => this.downloads.push({ candidate, signal, progress, resolve, reject })); },
	async verify(request) { return request.scenario === "conflict" ? "conflict" : "valid"; },
});
exports.waitFor = async condition => { for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("Fulltext condition timed out"); };
