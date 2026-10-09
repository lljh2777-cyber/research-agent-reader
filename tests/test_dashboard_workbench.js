const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { DashboardDataService } = loadReading("services/dashboard-data.ts", { obsidian: { normalizePath: p => p.replace(/\\/g, "/") } });
const { dashboardPaperDepth, dashboardTaskTitle } = loadReading("services/dashboard-presentation.ts");
const { dashboardActionGroup } = loadReading("services/dashboard-navigation.ts");
const { ACTIONS } = loadReading("actions.ts");
const record = (frontmatter = {}, extra = {}) => ({ frontmatter, tags: [], path: "wiki/sources/example.md", name: "example", text: "", ...extra });
(async () => {
	assert.deepEqual(ACTIONS.filter(a => a.showInRail !== false && dashboardActionGroup(a.id) === "tools").map(a => a.id), ["code-analysis", "code-practice", "vault-lint", "okf-export"]);
	for (const id of ["paper-ingest", "pdf-xray", "vault-retrieval", "synthesis", "fulltext-acquisition", "future-action"]) assert.equal(dashboardActionGroup(id), "common");
	assert.equal(ACTIONS.find(a => a.id === "pdf-xray").label, "文献深读");
	assert.deepEqual(ACTIONS.map(a => a.id), ["fulltext-acquisition", "paper-ingest", "pdf-xray", "code-analysis", "code-practice", "vault-retrieval", "synthesis", "annotation-explain", "vault-lint", "vault-lint-fix", "okf-export"]);
	const service = new DashboardDataService({}, { getTaskRuns: () => [] });
	const records = [record({ depth: "abstract-level", status: "ingested" }), record({ analysis_depth: "abstract-level" }), record({ status: "x-ray" }), record({ depth: "metadata-only", status: "x-ray" }), record({ status: "ingested" })];
	const depth = service.computePaperDepth(records);
	assert.deepEqual([depth.metadataOnly, depth.abstractLevel, depth.xray, depth.needXray], [2, 2, 1, 4]);
	assert.equal(dashboardPaperDepth(record({}, { tags: ["x-ray"] })), "x-ray");
	assert.equal(service.computeProcessingDepth(depth).reduce((sum, r) => sum + r.count, 0), records.length);
	const date = new Date(2027, 0, 15, 12), activity = service.computeActivity([
		record({}, { mtime: new Date(2026, 10, 1, 12).getTime() }),
		record({}, { mtime: new Date(2026, 9, 31, 12).getTime() }),
		record({}, { mtime: new Date(2027, 0, 16, 12).getTime() }),
	], date);
	assert.equal(activity.days.length % 7, 0); assert.ok(activity.days.length <= 98);
	assert.equal(activity.days.find(d => d.inRange).date, "2026-11-01");
	assert.equal(activity.days.reduce((sum, d) => sum + d.count, 0), 1);
	assert.equal(activity.days.filter(d => d.inRange).at(-1).date, "2027-01-15");
	const january = service.computeActivity([], new Date(2026, 0, 1)); assert.equal(january.days.find(d => d.inRange).date, "2025-11-01");
	const task = (id, status, day) => ({ id, status, actionId: "paper-ingest", label: "文献入库", summary: '"E:\\papers\\Original Title.pdf"', agent: "paper-intake-pipeline", startedAt: `2026-09-${day}T12:00:00Z`, executionConfig: { backend: "direct-api" } });
	assert.equal(dashboardTaskTitle(task("a", "done", "08"), new Map()), "Original Title");
	assert.equal(dashboardTaskTitle({ ...task("a", "done", "08"), summary: "papers/key/article.md" }, new Map()), "key");
	assert.equal(dashboardTaskTitle({ ...task("a", "done", "08"), summary: "papers/key/_extraction/source.pdf" }, new Map()), "key");
	const withArtifact = { ...task("a", "done", "08"), artifacts: { wikiPath: "wiki/sources/example.md" } };
	assert.equal(dashboardTaskTitle(withArtifact, new Map([["wiki/sources/example.md", record({ title: "Verified note title" })]])), "Verified note title");
	const tasks = Array.from({ length: 8 }, (_, i) => task(String(i), "done", "08")); tasks.push(task("old-failed", "failed", "01"), task("active", "running", "02"));
	const queue = new DashboardDataService({}, { getTaskRuns: () => tasks });
	const runs = await queue.computeAgentRuns(new Map());
	assert.equal(runs.length, 10); assert.equal(runs[0].runId, "active"); assert.equal(runs[1].runId, "old-failed"); assert.equal(runs[0].agent, "Direct API");
	assert.equal(runs[0].task, "Original Title"); assert.match(runs[0].detail, /E:\\papers/);
	assert.deepEqual(await service.computeAgentRuns(new Map()), []);
	console.log("DASHBOARD_WORKBENCH_OK: depth compatibility, rolling calendar, task titles and priority, complete history");
})().catch(e => { console.error(e); process.exitCode = 1; });
