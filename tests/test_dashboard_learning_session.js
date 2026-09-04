"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const pluginRoot = path.resolve(__dirname, "..");
const source = (relativePath) => fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");

function loadModelModule() {
	const compiled = esbuild.transformSync(source("src/learning/session-model.ts"), {
		loader: "ts",
		format: "cjs",
		target: "es2020",
	});
	const runtimeModule = { exports: {} };
	new Function("exports", "module", compiled.code)(runtimeModule.exports, runtimeModule);
	return runtimeModule.exports;
}

const model = loadModelModule();
const markdown = `---
title: "A traceable paper"
---
# A traceable paper

## Abstract
We test whether a structured intervention changes the primary outcome.

## Introduction
Prior work leaves the causal mechanism unresolved.

## Study design
Two cohorts were assigned to treatment and control groups.

## Methods
Samples were profiled and analysed with a preregistered model.

## Results
The primary endpoint improved. Figure 2 reports the main comparison.

## Discussion and limitations
The result may not generalize beyond the enrolled population.
`;

const sections = model.parseLearningSections(markdown);
assert.strictEqual(sections[0].heading, "A traceable paper");
assert.ok(sections.some((section) => section.heading === "Methods"));

const modules = model.buildLearningModules(markdown, "papers/example/article.md", [
	{ id: "fig-2", label: "Fig. 2", caption: "Primary comparison", pageIdx: 4 },
]);
assert.deepStrictEqual(
	modules.map((module) => module.id),
	["paper", "question", "background", "design", "methods", "results", "conclusion"],
);
assert.ok(modules.find((module) => module.id === "question").sectionHeadings.includes("Abstract"));
assert.ok(modules.find((module) => module.id === "results").evidence.some((item) => item.kind === "figure"));
assert.ok(modules.find((module) => module.id === "paper").evidence.some((item) => item.kind === "source"));

const firstBranch = model.createLearningBranch("methods", " 为什么需要这个模型？ ", [], "q-1");
const secondBranch = model.createLearningBranch("methods", "对假设有什么要求？", [firstBranch], "q-2");
assert.strictEqual(firstBranch.side, "above");
assert.strictEqual(secondBranch.side, "below");
assert.strictEqual(firstBranch.question, "为什么需要这个模型？");
assert.strictEqual(firstBranch.parentBranchId, "");
assert.strictEqual(firstBranch.answer, "");

const followUp = model.createLearningFollowUpBranch(
	firstBranch,
	"这个假设如何验证？",
	[firstBranch, secondBranch],
	"q-3",
);
assert.strictEqual(followUp.parentBranchId, "q-1");
assert.strictEqual(followUp.parentId, "methods");
model.applyLearningBranchAnswer(firstBranch, "回答正文", [
	{ id: "source-1", label: "Methods", detail: "papers/example/article.md", kind: "source" },
]);
assert.strictEqual(firstBranch.status, "answered");
assert.strictEqual(firstBranch.answer, "回答正文");
assert.strictEqual(firstBranch.answerEvidence.length, 1);

const normalized = model.normalizeLearningSessionState({
	articlePath: "papers/example/article.md",
	activeModuleId: "methods",
	selectedNodeId: "q-1",
	completedModuleIds: ["paper", "paper", "invalid"],
	branches: [firstBranch, { id: "bad", parentId: "invalid", question: "discard" }],
});
assert.deepStrictEqual(normalized.completedModuleIds, ["paper"]);
assert.strictEqual(normalized.branches.length, 1);
assert.strictEqual(normalized.selectedNodeId, "q-1");
assert.strictEqual(model.nextLearningModuleId("methods"), "results");
assert.strictEqual(model.nextLearningModuleId("conclusion"), "conclusion");

const prompt = model.buildLearningQuestionPrompt(
	"papers/example/article.md",
	modules.find((module) => module.id === "methods"),
	"这个方法的关键假设是什么？",
);
assert.match(prompt, /papers\/example\/article\.md/);
assert.match(prompt, /当前主线模块是“方法”/);
assert.match(prompt, /优先检查章节：Methods/);
assert.match(prompt, /明确区分原文证据、知识库补充和推断/);

const followUpPrompt = model.buildLearningQuestionPrompt(
	"papers/example/article.md",
	modules.find((module) => module.id === "methods"),
	"那在小样本中呢？",
	{ question: "这个方法的关键假设是什么？", answer: "需要样本独立。" },
);
assert.match(followUpPrompt, /继续追问/);
assert.match(followUpPrompt, /需要样本独立/);

const pluginSource = source("src/plugin.ts");
const actionSource = source("src/actions.ts");
const dashboardSource = source("src/views/dashboard.ts");
const viewSource = source("src/views/learning-session.ts");
const styles = source("styles.css");

assert.match(actionSource, /id:\s*"paper-learning"/);
assert.match(actionSource, /learningView:\s*true/);
assert.match(pluginSource, /registerView\(LEARNING_SESSION_VIEW_TYPE/);
assert.match(pluginSource, /id:\s*"open-paper-learning-session"/);
assert.match(pluginSource, /setTitle\("开始文献学习"\)/);
assert.match(dashboardSource, /action\.learningView/);
assert.match(viewSource, /class LearningSessionView extends ItemView/);
assert.match(viewSource, /createLearningBranch/);
assert.match(viewSource, /createLearningFollowUpBranch/);
assert.match(viewSource, /applyLearningBranchAnswer/);
assert.match(viewSource, /activateQueryWikiView\(prompt, completionHandler\)/);
assert.match(viewSource, /activateMineruReaderView\(this\.sessionState\.articlePath\)/);
assert.match(viewSource, /stage\.offsetTop - \(scroller\.clientHeight - stage\.clientHeight\) \/ 2/);
assert.match(viewSource, /renderFigurePreview\(evidenceSection\)/);
assert.match(viewSource, /verifiedResourceUrls/);
assert.match(styles, /\.learning-session-map-track/);
assert.match(styles, /\.learning-session-spine-stage/);
assert.match(styles, /\.learning-session-mind-map/);
assert.match(styles, /\.learning-session-tree-node\.is-answer/);
assert.match(styles, /\.learning-session-tree-node\.is-follow-up/);
assert.match(styles, /\.learning-session-inspector/);

const queryViewSource = source("src/views/query-wiki.ts");
assert.match(queryViewSource, /pendingCompletionHandler/);
assert.match(queryViewSource, /notifyCompletion\(completionHandler/);

console.log("DASHBOARD_LEARNING_SESSION_TEST_OK");
