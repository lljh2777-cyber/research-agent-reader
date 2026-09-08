const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { SETTINGS_ENTRIES, SETTINGS_CATEGORIES, filterSettingsEntries } = loadReading("settings/navigation.ts");
const pages = (filter, query = "") => filterSettingsEntries(filter, query).map(e => e.page);

// Discover common settings, and reach every optional page through categories or search.
assert.equal(pages("common").length, 6);
assert.equal(new Set(SETTINGS_ENTRIES.map(e => e.page)).size, 12);
assert.deepEqual(new Set(SETTINGS_CATEGORIES.flatMap(c => pages(c.id))), new Set(pages("all")));
assert.ok(pages("connections").includes("codex"));
assert.ok(!pages("reading").includes("codex"));
for (const [question, expected] of [
	["API key", "direct-api"], ["ＳｉｌｉｃｏｎＦｌｏｗ", "retrieval"],
	["embedding", "retrieval"], ["PDF OCR", "mineru"], ["导出", "data"],
	["Codex 路径", "runtime"], ["  cLaUdE  ", "claude"], ["划选", "annotations"],
]) {
	assert.ok(pages("common", question).includes(expected), `${question} should find ${expected}`);
	assert.deepEqual(pages("reading", question), pages("all", question), "search must cover hidden categories");
}
assert.deepEqual(pages("all", "no-such-feature-xyz"), []);
assert.deepEqual(pages("common", "  "), pages("common"));
assert.deepEqual(pages("all", "<script>"), []);
console.log("SETTINGS_NAVIGATION_TEST_OK");
