"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const pluginRoot = path.resolve(__dirname, "..");
const hookEntry = path.join(pluginRoot, "tests", "safe-markdown-hooks.ts");
const hookBuild = esbuild.buildSync({
	entryPoints: [path.join(pluginRoot, "src", "security", "safe-markdown.ts")],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	target: "node20",
	logLevel: "silent",
});
const hookModule = new Module(hookEntry, module);
hookModule.filename = hookEntry;
hookModule.paths = Module._nodeModulePaths(pluginRoot);
hookModule._compile(hookBuild.outputFiles[0].text, hookEntry);

const {
	assertPassiveMineruMarkdown,
	derivePassiveMineruMarkdown,
	validateModelNoteBodyMarkdown,
} = hookModule.exports;

function violationKinds(markdown) {
	return new Set(validateModelNoteBodyMarkdown(markdown).map((item) => item.kind));
}

function testActiveMarkdownIsClosedBeforeRendering() {
	const attacks = [
		["![tracking][remote]\n\n[remote]: https://example.invalid/opened", "reference-image"],
		["![collapsed][]\n\n[collapsed]: https://example.invalid/opened", "reference-image"],
		["![shortcut]", "reference-image"],
		["![[Vault embed]]", "obsidian-embed"],
		["<iframe src=https://example.invalid></iframe>", "raw-html"],
		["<object data='https://example.invalid'></object>", "raw-html"],
		["<embed src = https://example.invalid >", "raw-html"],
		["<img src = https://example.invalid/tracker.png loading=lazy>", "raw-html"],
		["```some-active-language\npayload\n```", "fenced-code"],
		["~~~unknown-processor\npayload\n~~~", "fenced-code"],
		["- > [!note] nested callout", "plugin-callout"],
		["> - [!warning] nested callout", "plugin-callout"],
		["- :::danger", "plugin-directive"],
		["> 1. ~~~unknown-processor\npayload\n~~~", "fenced-code"],
		["[open](obsidian://open?vault=x)", "link"],
	];
	for (const [markdown, kind] of attacks) {
		assert.ok(violationKinds(markdown).has(kind), `must reject ${kind}: ${markdown}`);
		assert.throws(() => assertPassiveMineruMarkdown(markdown), /活动或未绑定 Markdown/);
	}

	let processorCalls = 0;
	const renderOnlyAfterBoundary = (markdown) => {
		assertPassiveMineruMarkdown(markdown);
		processorCalls += 1;
	};
	assert.throws(
		() => renderOnlyAfterBoundary("```registered-language\nnetwork request\n```"),
		/活动或未绑定 Markdown/,
	);
	assert.equal(processorCalls, 0, "a registered code-block processor must not receive rejected input");
}

function testPassiveDerivativeAndSafeProse() {
	const raw = [
		"# Paper",
		"",
		"Math prose keeps <p、q> and E<mc² intact.",
		"<iframe src='https://example.invalid'></iframe>",
		"![remote](https://example.invalid/tracker.png)",
		"![[Secret note]]",
		"<img src=images/figure-2.webp loading=lazy>",
	].join("\n");
	const passive = derivePassiveMineruMarkdown(raw);
	assert.doesNotMatch(passive, /iframe|example\.invalid|!\[\[/);
	assert.match(passive, /<p、q>/);
	assert.match(passive, /E<mc²/);
	assert.match(passive, /!\[\]\(images\/figure-2\.webp\)/);
	assert.doesNotThrow(() => assertPassiveMineruMarkdown(
		passive,
		new Set(["images/figure-2.webp"]),
	));
	const inertFence = derivePassiveMineruMarkdown("```some-active-language\npayload\n```\n");
	assert.doesNotMatch(inertFence, /`|~{3}/);
	assert.match(inertFence, /> '''some-active-language/);
	assert.doesNotThrow(() => assertPassiveMineruMarkdown(inertFence));
	for (const nested of ["- > [!note] payload", "> - [!warning] payload", "- :::danger"]) {
		const inertNested = derivePassiveMineruMarkdown(nested);
		assert.deepEqual(validateModelNoteBodyMarkdown(inertNested), []);
	}
	assert.throws(
		() => derivePassiveMineruMarkdown("<img src = 'images/figure 1.png' onerror='bad'>"),
		/无法生成安全 article\.md/,
		"an ambiguous HTML image source with spaces must fail closed",
	);

	const prose = [
		"## 研究问题",
		"使用 <p、q> 记号，且 E<mc² 近似成立。",
		"[官网](https://example.org)。",
		"[网站][ref]",
		"[ref]: https://example.org \"Example\"",
	].join("\n\n");
	assert.deepEqual(validateModelNoteBodyMarkdown(prose), []);
	assert.ok(violationKinds("```mermaid\ngraph TD\n```").has("fenced-code"));
}

testActiveMarkdownIsClosedBeforeRendering();
testPassiveDerivativeAndSafeProse();
console.log("SAFE_MARKDOWN_TESTS_OK");
