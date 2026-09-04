"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require(path.resolve(
	__dirname,
	"../node_modules/esbuild",
));

const pluginRoot = path.resolve(__dirname, "..");

function read(relativePath) {
	return fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");
}

function loadTsModule(relativePath) {
	const entry = path.join(pluginRoot, relativePath);
	const result = esbuild.buildSync({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: "cjs",
		platform: "node",
		target: "node18",
		logLevel: "silent",
	});
	const output = result.outputFiles[0].text;
	const loaded = new Module(entry, module);
	loaded.filename = entry;
	loaded.paths = Module._nodeModulePaths(path.dirname(entry));
	loaded._compile(output, entry);
	return loaded.exports;
}

const normalization = loadTsModule("src/mineru/normalization.ts");
const markdown = loadTsModule("src/mineru/reader-markdown.ts");
const visualCandidates = loadTsModule("src/mineru/visual-candidates.ts");
const visualRepair = loadTsModule("src/mineru/visual-repair.ts");

assert.deepEqual(markdown.readerMarkdownRestoreTarget("visuals", "", 1), { kind: "top" });
assert.deepEqual(markdown.readerMarkdownRestoreTarget("pdf", "", 1), { kind: "top" });
assert.deepEqual(markdown.readerMarkdownRestoreTarget("pdf", "", 4), {
	kind: "page",
	pageNumber: 4,
});
assert.deepEqual(markdown.readerMarkdownRestoreTarget("visuals", "figure-2", 1), {
	kind: "visual",
	visualId: "figure-2",
});

const v1 = [
	{
		type: "image",
		page_idx: 0,
		bbox: [50, 60, 450, 360],
		img_path: "images/a.jpg",
		image_caption: ["Fig. 1. Complete caption"],
	},
	{
		type: "text",
		page_idx: 1,
		bbox: [50, 100, 900, 180],
		text: "Body",
	},
];
const v2 = [
	[
		{
			type: "image",
			bbox: [50, 60, 450, 360],
			content: {
				image_source: { path: "images/a.jpg" },
				image_caption: [{ type: "text", content: "Fig. 1. Complete caption" }],
			},
		},
	],
	[
		{
			type: "paragraph",
			bbox: [50, 100, 900, 180],
			content: { paragraph_content: [{ type: "text", content: "Body" }] },
		},
	],
];

const sourceMarkdown = "# Example\n\n![](images/a.jpg)\n";
const v1Index = normalization.buildRuntimeViewerIndex(v1, sourceMarkdown);
const v2Index = normalization.buildRuntimeViewerIndex(v2, sourceMarkdown);
assert.equal(v1Index.pages.length, 2);
assert.equal(v2Index.pages.length, 2);
assert.deepEqual(
	[v1Index.pages[0].blocks[0].role, v1Index.pages[0].blocks[0].asset_path],
	[v2Index.pages[0].blocks[0].role, v2Index.pages[0].blocks[0].asset_path],
);
assert.equal(v2Index.pages[0].blocks[0].caption.text, "Fig. 1. Complete caption");
assert.equal(normalization.figureKeyFromText("Figure 2 | Formal caption"), "figure:2");
assert.equal(normalization.figureKeyFromText("Figure S_2 | Formal caption"), "figure:s_2");
assert.equal(normalization.figureKeyFromText("Fig. 2. Formal caption"), "figure:2");
assert.equal(normalization.formalFigureCaptionKeyFromText("Fig. 2. Formal caption"), "figure:2");
assert.equal(normalization.formalFigureCaptionKeyFromText("Fig. 2 shows the result"), "");
assert.equal(normalization.formalFigureCaptionKeyFromText("Fig. 2..."), "");
assert.equal(normalization.formalFigureCaptionKeyFromText("Fig. 5c–g shows the result."), "");
assert.equal(
	normalization.formalFigureCaptionKeyFromText("Supporting Information Figure 2.1 | A complete validation overview."),
	"supporting-figure:2_1",
);
assert.equal(
	normalization.formalFigureCaptionKeyFromText("Figure 2.1 A complete caption without punctuation delimiter."),
	"figure:2_1",
);
assert.equal(normalization.formalFigureCaptionKeyFromText("Figure 2.1 illustrates the workflow."), "");
assert.equal(normalization.formalFigureCaptionKeyFromText("Figure 2 provides the comparison."), "");
assert.equal(normalization.formalFigureCaptionKeyFromText("Our Figure 2 is discussed here."), "");
assert.equal(normalization.formalFigureCaptionKeyFromText("Figure 2 map"), "");
assert.equal(normalization.classifyCaptionPart("Fig. 5c–g shows the result."), "other");

const runtimeRepairMarkdown = [
	"![](images/panel-a.jpg)",
	"![](images/panel-b.jpg)",
	"![](images/panel-c.jpg)",
	"![](images/panel-d.jpg)",
].join("\n");
const runtimeArticleHash = "a".repeat(64);
const runtimeMineruHash = "b".repeat(64);
const runtimeRepairPayload = [
	{ type: "image", page_idx: 0, bbox: [100, 100, 300, 300], img_path: "images/panel-a.jpg", image_caption: ["A"] },
	{ type: "image", page_idx: 0, bbox: [310, 100, 510, 300], img_path: "images/panel-b.jpg", image_caption: ["B"] },
	{ type: "image", page_idx: 0, bbox: [100, 310, 300, 510], img_path: "images/panel-c.jpg", image_caption: ["C"] },
	{ type: "image", page_idx: 0, bbox: [310, 310, 510, 510], img_path: "images/panel-d.jpg", image_caption: ["D"] },
];
const runtimeRepairIndex = normalization.buildRuntimeViewerIndex(
	runtimeRepairPayload,
	runtimeRepairMarkdown,
	{ articleSha256: runtimeArticleHash, mineruResultSha256: runtimeMineruHash, packagedSourcePdf: true },
);
const runtimeRepairPlan = visualRepair.buildRuntimeVisualRepair(runtimeRepairIndex);
assert.equal(runtimeRepairPlan.groups.length, 1);
assert.equal(runtimeRepairPlan.groups[0].decision, "auto");
assert.equal(runtimeRepairPlan.groups[0].replacement.mode, "pdf_crop");
assert.deepEqual(runtimeRepairPlan.groups[0].replacement.bbox_norm, [100, 100, 510, 510]);
assert.equal(runtimeRepairPlan.groups[0].member_markdown_image_ids.length, 4);
assert.deepEqual(visualRepair.validateVisualContracts({
	viewerIndex: runtimeRepairIndex,
	visualRepair: runtimeRepairPlan,
	sourceIndex: runtimeRepairIndex,
	articleHash: runtimeArticleHash,
	mineruHash: runtimeMineruHash,
}), []);

const visualOnlyStripMarkdown = Array.from(
	{ length: 5 },
	(_value, index) => `![](images/page-strip-${index + 1}.jpg)`,
).join("\n");
const visualOnlyStripPayload = Array.from({ length: 5 }, (_value, index) => ({
	type: "image",
	page_idx: 6,
	bbox: [100, 50 + index * 180, 900, 228 + index * 180],
	img_path: `images/page-strip-${index + 1}.jpg`,
	...(index === 0 ? { image_caption: ["B"] } : {}),
}));
const visualOnlyStripIndex = normalization.buildRuntimeViewerIndex(
	visualOnlyStripPayload,
	visualOnlyStripMarkdown,
	{ packagedSourcePdf: true },
);
const visualOnlyStripPlan = visualRepair.buildRuntimeVisualRepair(visualOnlyStripIndex);
assert.equal(visualOnlyStripPlan.algorithm_version, "visual-repair-v1.11");
assert.equal(visualOnlyStripPlan.groups.length, 1);
assert.equal(visualOnlyStripPlan.groups[0].decision, "auto");
assert.equal(visualOnlyStripPlan.groups[0].confidence, 0.9);
assert.ok(visualOnlyStripPlan.groups[0].reason_codes.includes("visual_only_page_exact_coverage"));
assert.equal(visualOnlyStripPlan.groups[0].signals.visual_only_page_exact_coverage, true);

const visualOnlyWithBodyIndex = normalization.buildRuntimeViewerIndex(
	[
		...visualOnlyStripPayload,
		{ type: "text", page_idx: 6, bbox: [100, 950, 900, 980], text: "正文证据必须阻止整页视觉自动合并。" },
	],
	visualOnlyStripMarkdown,
	{ packagedSourcePdf: true },
);
assert.equal(visualRepair.buildRuntimeVisualRepair(visualOnlyWithBodyIndex).groups[0].decision, "review");

// Logical Figure ownership comes from one formal caption identity plus the
// exact article.md image run. Body text on the page must not prevent a valid
// multi-asset Figure from being reconstructed.
const captionOwnedMarkdown = [
	"Introductory body text.",
	"![](images/caption-owned-a.jpg)",
	"![](images/caption-owned-b.jpg)",
	"![](images/caption-owned-c.jpg)",
	"Fig. 2. A formal caption for the complete multi-panel figure.",
	"Following body text.",
].join("\n");
const captionOwnedPayload = [
	{ type: "text", page_idx: 4, bbox: [80, 40, 920, 90], text: "Introductory body text." },
	{ type: "image", page_idx: 4, bbox: [80, 120, 360, 420], img_path: "images/caption-owned-a.jpg" },
	{ type: "image", page_idx: 4, bbox: [370, 120, 650, 420], img_path: "images/caption-owned-b.jpg" },
	{
		type: "image",
		page_idx: 4,
		bbox: [660, 120, 920, 420],
		img_path: "images/caption-owned-c.jpg",
		image_caption: ["Fig. 2. A formal caption for the complete multi-panel figure."],
	},
	{ type: "text", page_idx: 4, bbox: [80, 450, 920, 500], text: "Following body text." },
];
const captionOwnedIndex = normalization.buildRuntimeViewerIndex(
	captionOwnedPayload,
	captionOwnedMarkdown,
	{ packagedSourcePdf: true },
);
const captionOwnedPlan = visualRepair.buildRuntimeVisualRepair(captionOwnedIndex);
const captionOwnedAuto = captionOwnedPlan.groups.filter((group) => group.decision === "auto");
assert.equal(captionOwnedAuto.length, 1);
assert.equal(captionOwnedAuto[0].figure_key, "figure:2");
assert.equal(captionOwnedAuto[0].member_block_ids.length, 3);
assert.ok(captionOwnedAuto[0].reason_codes.includes("formal_caption_page_ownership"));
const captionOwnedBlocks = captionOwnedIndex.pages.flatMap((page) => page.blocks);
const captionOwnedDetails = markdown.resolveVisualCaptionDetails(
	captionOwnedAuto[0].member_block_ids.map((id) => captionOwnedBlocks.find((block) => block.id === id)),
	captionOwnedBlocks,
	captionOwnedPlan,
	4,
	captionOwnedIndex,
);
assert.equal(markdown.visualLabelFromCaption(captionOwnedDetails.caption, 1), "Fig. 2");
assert.equal(captionOwnedDetails.captionSourceProjections.length, 1);
const captionOwnedPrepared = markdown.prepareReaderMarkdown(captionOwnedMarkdown, [{
	id: "caption-owned-figure",
	pageIdx: 4,
	label: "Fig. 2",
	...captionOwnedDetails,
	memberBlockIds: captionOwnedAuto[0].member_block_ids,
	memberAssetPaths: [
		"images/caption-owned-a.jpg",
		"images/caption-owned-b.jpg",
		"images/caption-owned-c.jpg",
	],
	memberMarkdownImageIds: captionOwnedAuto[0].member_markdown_image_ids,
	anchorAssetPath: "images/caption-owned-a.jpg",
	display: { mode: "pdf-crop", bbox: [80, 120, 920, 420], padding: 8 },
	repairDecision: "auto",
	confidence: 0.98,
}], captionOwnedIndex);
assert.doesNotMatch(captionOwnedPrepared, /Fig\. 2\. A formal caption/);
assert.match(captionOwnedPrepared, /Introductory body text\./);
assert.match(captionOwnedPrepared, /Following body text\./);

// When the caption is between two image runs, a key already anchored to the
// previous visual page is excluded and the remaining formal caption owns the
// following run. This also covers MinerU JSON that omitted the new caption.
const boundaryOwnedMarkdown = [
	"![](images/previous.jpg)",
	"Fig. 1. Caption for the previous figure.",
	"Extended Data Fig. 9. Caption present only in article Markdown.",
	"![](images/boundary-a.jpg)",
	"![](images/boundary-b.jpg)",
].join("\n");
const boundaryOwnedIndex = normalization.buildRuntimeViewerIndex([
	{
		type: "image",
		page_idx: 0,
		bbox: [100, 100, 900, 700],
		img_path: "images/previous.jpg",
		image_caption: ["Fig. 1. Caption for the previous figure."],
	},
	{ type: "image", page_idx: 1, bbox: [100, 100, 480, 700], img_path: "images/boundary-a.jpg" },
	{ type: "image", page_idx: 1, bbox: [520, 100, 900, 700], img_path: "images/boundary-b.jpg" },
], boundaryOwnedMarkdown, { packagedSourcePdf: true });
assert.deepEqual(
	boundaryOwnedIndex.markdown_captions.map((caption) => caption.figure_key),
	["figure:1", "extended-data-figure:9"],
);
const boundaryOwnedPlan = visualRepair.buildRuntimeVisualRepair(boundaryOwnedIndex);
const boundaryOwnedGroup = boundaryOwnedPlan.groups.find((group) => group.figure_key === "extended-data-figure:9");
assert.ok(boundaryOwnedGroup);
assert.equal(boundaryOwnedGroup.decision, "auto");
assert.equal(boundaryOwnedGroup.member_block_ids.length, 2);
const boundaryBlocks = boundaryOwnedIndex.pages.flatMap((page) => page.blocks);
const boundaryDetails = markdown.resolveVisualCaptionDetails(
	boundaryOwnedGroup.member_block_ids.map((id) => boundaryBlocks.find((block) => block.id === id)),
	boundaryBlocks,
	boundaryOwnedPlan,
	1,
	boundaryOwnedIndex,
);
assert.equal(markdown.visualLabelFromCaption(boundaryDetails.caption, 1), "Extended Data Fig. 9");

const visualOnlyWithoutPdfIndex = normalization.buildRuntimeViewerIndex(
	visualOnlyStripPayload,
	visualOnlyStripMarkdown,
	{ articleSha256: runtimeArticleHash, mineruResultSha256: runtimeMineruHash },
);
const visualOnlyWithoutPdfPlan = visualRepair.buildRuntimeVisualRepair(visualOnlyWithoutPdfIndex);
assert.equal(visualOnlyWithoutPdfPlan.groups[0].decision, "review");
assert.ok(visualOnlyWithoutPdfPlan.groups[0].warning_codes.includes("source_pdf_unavailable"));
assert.deepEqual(visualRepair.validateVisualContracts({
	viewerIndex: visualOnlyWithoutPdfIndex,
	visualRepair: visualOnlyWithoutPdfPlan,
	sourceIndex: visualOnlyWithoutPdfIndex,
	articleHash: runtimeArticleHash,
	mineruHash: runtimeMineruHash,
}), []);
const forgedNoPdfAuto = structuredClone(visualOnlyWithoutPdfPlan);
forgedNoPdfAuto.groups[0].decision = "auto";
forgedNoPdfAuto.groups[0].confidence = 0.9;
assert.ok(visualRepair.validateVisualContracts({
	viewerIndex: visualOnlyWithoutPdfIndex,
	visualRepair: forgedNoPdfAuto,
	sourceIndex: visualOnlyWithoutPdfIndex,
	articleHash: runtimeArticleHash,
	mineruHash: runtimeMineruHash,
}).some((error) => error.includes("不得自动执行 pdf_crop")));

const fullCompositeCaption = "Fig. 5 | Complete full-page composite. (A) First panel. (B) Second panel. (C) Third panel. (D) Fourth panel. (E) Fifth panel. (F) Sixth panel. (G) Seventh panel. (H) Eighth panel. (I) Ninth panel.";
const fullCompositeBody = "Following body paragraph remains present and must never be absorbed into the caption projection.";
const fullCompositeMarkdown = [
	...Array.from({ length: 9 }, (_value, index) => [
		String.fromCharCode(65 + index),
		`![](images/full-composite-${index + 1}.jpg)`,
		`panel-${index + 1} ${"fragment metadata ".repeat(14)}`,
	].join("\n")),
	fullCompositeCaption,
	fullCompositeBody,
	"![](images/following-figure.jpg)",
].join("\n\n");
const fullCompositePayload = [
	...Array.from({ length: 9 }, (_value, index) => ({
		type: "image",
		page_idx: 10,
		bbox: index === 0
			? [100, 80, 590, 300]
			: [100 + (index % 3) * 270, 80 + Math.floor(index / 3) * 270, 320 + (index % 3) * 270, 300 + Math.floor(index / 3) * 270],
		img_path: `images/full-composite-${index + 1}.jpg`,
		image_caption: [String.fromCharCode(65 + index)],
	})),
	{ type: "text", page_idx: 11, bbox: [100, 50, 900, 170], text: fullCompositeCaption },
	{ type: "text", page_idx: 11, bbox: [100, 180, 900, 260], text: fullCompositeBody },
	{ type: "image", page_idx: 11, bbox: [100, 500, 900, 800], img_path: "images/following-figure.jpg" },
];
const fullCompositeIndex = normalization.buildRuntimeViewerIndex(
	fullCompositePayload,
	fullCompositeMarkdown,
	{ packagedSourcePdf: true },
);
const fullCompositePlan = visualRepair.buildRuntimeVisualRepair(fullCompositeIndex);
assert.equal(fullCompositePlan.groups.length, 1);
assert.equal(fullCompositePlan.groups[0].decision, "auto");
assert.equal(fullCompositePlan.groups[0].member_block_ids.length, 9);
assert.deepEqual(fullCompositePlan.groups[0].replacement.bbox_norm, [100, 80, 860, 840]);
assert.ok(fullCompositePlan.groups[0].reason_codes.includes("visual_only_page_full_coverage"));
assert.equal(fullCompositePlan.groups[0].signals.enclosing_alias_count, 1);
const fullCompositeBlocks = fullCompositeIndex.pages.find((page) => page.page_idx === 10).blocks
	.filter((block) => block.role === "visual");
const fullCompositeDetails = markdown.resolveVisualCaptionDetails(
	fullCompositeBlocks,
	fullCompositeIndex.pages.flatMap((page) => page.blocks),
	fullCompositePlan,
	10,
);
assert.equal(fullCompositeDetails.caption, fullCompositeCaption);
assert.equal(fullCompositeDetails.captionPageIdx, 11);
assert.deepEqual(fullCompositeDetails.pageRange, [10, 11]);
assert.equal(fullCompositeDetails.captionSourceProjections.length, 2);
assert.equal(fullCompositeDetails.captionSourceProjections[0].suppress, true);
assert.equal(fullCompositeDetails.captionSourceProjections[1].suppress, false);
const fullCompositePrepared = markdown.prepareReaderMarkdown(
	fullCompositeMarkdown,
	[{
		id: fullCompositePlan.groups[0].id,
		pageIdx: 10,
		label: "Fig. 5",
		...fullCompositeDetails,
		memberBlockIds: fullCompositeBlocks.map((block) => block.id),
		memberAssetPaths: fullCompositeBlocks.map((block) => block.asset_path),
		memberMarkdownImageIds: [...fullCompositePlan.groups[0].member_markdown_image_ids],
		anchorAssetPath: fullCompositeBlocks[0].asset_path,
		display: { mode: "pdf-crop", bbox: [100, 80, 860, 840], padding: 6 },
		repairDecision: "auto",
		confidence: 0.93,
	}],
	fullCompositeIndex,
);
assert.ok(!fullCompositePrepared.includes(fullCompositeCaption));
assert.ok(fullCompositePrepared.includes(fullCompositeBody));

const secondFormalCaption = "Fig. 6 | A second formal caption makes the next-page ownership ambiguous. (A) First panel. (B) Second panel. (C) Third panel.";
const ambiguousFullCompositeMarkdown = fullCompositeMarkdown.replace(fullCompositeBody, secondFormalCaption);
const ambiguousFullCompositePayload = fullCompositePayload.map((block) => (
	block.type === "text" && block.text === fullCompositeBody
		? { ...block, text: secondFormalCaption }
		: block
));
const ambiguousFullCompositeIndex = normalization.buildRuntimeViewerIndex(
	ambiguousFullCompositePayload,
	ambiguousFullCompositeMarkdown,
	{ packagedSourcePdf: true },
);
const ambiguousFullCompositePlan = visualRepair.buildRuntimeVisualRepair(ambiguousFullCompositeIndex);
const ambiguousFullCompositeBlocks = ambiguousFullCompositeIndex.pages.find((page) => page.page_idx === 10).blocks
	.filter((block) => block.role === "visual");
assert.equal(markdown.resolveVisualCaptionDetails(
	ambiguousFullCompositeBlocks,
	ambiguousFullCompositeIndex.pages.flatMap((page) => page.blocks),
	ambiguousFullCompositePlan,
	10,
).caption, "");

const terminalFullPageCaption = "Fig. 6 | Terminal full-page figure. (A) First verified panel. (B) Second verified panel. (C) Third verified panel. (D) Fourth verified panel.";
const terminalFullPageBody = "Terminal following body remains visible after the exact caption projection.";
const terminalFullPageMarkdown = [
	"![](images/earlier-figure.jpg)",
	"![](images/terminal-full-page.jpg)",
	terminalFullPageCaption,
	terminalFullPageBody,
].join("\n\n");
const terminalFullPageIndex = normalization.buildRuntimeViewerIndex([
	{ type: "image", page_idx: 0, bbox: [100, 100, 300, 300], img_path: "images/earlier-figure.jpg" },
	{ type: "image", page_idx: 2, bbox: [100, 50, 900, 950], img_path: "images/terminal-full-page.jpg" },
	{ type: "text", page_idx: 3, bbox: [50, 50, 950, 220], text: terminalFullPageCaption },
	{ type: "text", page_idx: 3, bbox: [50, 240, 950, 330], text: terminalFullPageBody },
], terminalFullPageMarkdown, { packagedSourcePdf: true });
const terminalFullPageBlock = terminalFullPageIndex.pages.find((page) => page.page_idx === 2).blocks[0];
const terminalFullPageDetails = markdown.resolveVisualCaptionDetails(
	[terminalFullPageBlock],
	terminalFullPageIndex.pages.flatMap((page) => page.blocks),
	null,
	2,
);
assert.equal(terminalFullPageDetails.caption, terminalFullPageCaption);
assert.deepEqual(terminalFullPageDetails.captionSourceImageBounds, {
	beforeMarkdownImageId: "md-img-0001",
});
const terminalFullPagePrepared = markdown.prepareReaderMarkdown(
	terminalFullPageMarkdown,
	[{
		id: "terminal-full-page",
		pageIdx: 2,
		label: "Fig. 6",
		...terminalFullPageDetails,
		memberBlockIds: [terminalFullPageBlock.id],
		memberAssetPaths: [terminalFullPageBlock.asset_path],
		memberMarkdownImageIds: [...terminalFullPageBlock.markdown_image_ids],
		anchorAssetPath: terminalFullPageBlock.asset_path,
		display: { mode: "asset", assetPath: terminalFullPageBlock.asset_path },
		repairDecision: "keep-original",
		confidence: 1,
	}],
	terminalFullPageIndex,
);
assert.ok(!terminalFullPagePrepared.includes(terminalFullPageCaption));
assert.ok(terminalFullPagePrepared.includes(terminalFullPageBody));

const smallTerminalIndex = normalization.buildRuntimeViewerIndex([
	{ type: "image", page_idx: 2, bbox: [100, 100, 400, 400], img_path: "images/small-terminal.jpg" },
	{ type: "text", page_idx: 3, bbox: [50, 50, 950, 220], text: terminalFullPageCaption },
	{ type: "text", page_idx: 3, bbox: [50, 240, 950, 330], text: terminalFullPageBody },
], terminalFullPageMarkdown.replace("earlier-figure.jpg", "small-terminal.jpg"), { packagedSourcePdf: true });
const smallTerminalBlock = smallTerminalIndex.pages.find((page) => page.page_idx === 2).blocks[0];
assert.equal(markdown.resolveVisualCaptionDetails(
	[smallTerminalBlock],
	smallTerminalIndex.pages.flatMap((page) => page.blocks),
	null,
	2,
).caption, "");

const fullCompositeWithBodyIndex = normalization.buildRuntimeViewerIndex(
	[
		...fullCompositePayload.slice(0, 9),
		{ type: "text", page_idx: 10, bbox: [100, 850, 900, 900], text: "A real body block prevents full-page consolidation." },
		...fullCompositePayload.slice(9),
	],
	fullCompositeMarkdown,
	{ packagedSourcePdf: true },
);
assert.ok(visualRepair.buildRuntimeVisualRepair(fullCompositeWithBodyIndex).groups.every((group) => (
	!group.reason_codes.includes("visual_only_page_full_coverage")
)));

const overlappingCropGroups = visualRepair.downgradeOverlappingAutoCropGroups([{
	id: "overlap-left",
	page_idx: 10,
	member_block_ids: ["a", "b"],
	decision: "auto",
	confidence: 0.9,
	replacement: { mode: "pdf_crop", bbox_norm: [100, 100, 700, 700] },
}, {
	id: "overlap-right",
	page_idx: 10,
	member_block_ids: ["c", "d"],
	decision: "auto",
	confidence: 0.91,
	replacement: { mode: "pdf_crop", bbox_norm: [500, 500, 900, 900] },
}], []);
assert.ok(overlappingCropGroups.every((group) => group.decision === "review"));
assert.ok(overlappingCropGroups.every((group) => group.warning_codes.includes("overlapping_auto_crop_groups")));

const reviewCandidates = visualCandidates.buildVisualCandidates(
	visualOnlyWithoutPdfIndex,
	visualOnlyWithoutPdfPlan,
);
assert.equal(reviewCandidates.status, "ready");
assert.equal(reviewCandidates.candidates.length, 1);
assert.equal(reviewCandidates.candidates[0].kind, "fragment_group");
assert.equal(reviewCandidates.candidates[0].review_state, "review");
assert.equal(JSON.stringify(reviewCandidates).includes("page-strip-"), false, "candidate packet must omit asset paths");
assert.deepEqual(visualCandidates.validateVisualCandidates(
	reviewCandidates,
	visualOnlyWithoutPdfIndex,
	visualOnlyWithoutPdfPlan,
), []);
const selfConsistentCandidateTamper = structuredClone(reviewCandidates);
selfConsistentCandidateTamper.candidates[0].base_confidence = 0.7;
selfConsistentCandidateTamper.candidate_package_sha256 = visualCandidates.visualCandidatePackageSha256(
	selfConsistentCandidateTamper,
);
assert.ok(visualCandidates.validateVisualCandidates(
	selfConsistentCandidateTamper,
	visualOnlyWithoutPdfIndex,
	visualOnlyWithoutPdfPlan,
).some((error) => error.includes("不是由当前输入规范重建")));

const enclosingAliasMarkdown = [
	"![](images/whole-figure.jpg)",
	"![](images/alias-a.jpg)",
	"![](images/alias-b.jpg)",
	"![](images/alias-c.jpg)",
].join("\n");
const enclosingAliasIndex = normalization.buildRuntimeViewerIndex([
	{ type: "image", page_idx: 12, bbox: [100, 100, 900, 800], img_path: "images/whole-figure.jpg" },
	{ type: "image", page_idx: 12, bbox: [120, 130, 360, 360], img_path: "images/alias-a.jpg" },
	{ type: "image", page_idx: 12, bbox: [380, 130, 620, 360], img_path: "images/alias-b.jpg" },
	{ type: "image", page_idx: 12, bbox: [640, 130, 880, 360], img_path: "images/alias-c.jpg" },
], enclosingAliasMarkdown);
const enclosingAliasPlan = visualRepair.buildRuntimeVisualRepair(enclosingAliasIndex);
assert.equal(enclosingAliasPlan.groups.length, 1);
assert.equal(enclosingAliasPlan.groups[0].replacement.mode, "existing_asset");
assert.equal(enclosingAliasPlan.groups[0].decision, "auto");
assert.ok(enclosingAliasPlan.groups[0].reason_codes.includes("complete_enclosing_asset_exact_aliases"));
const tamperedRuntimeIndex = structuredClone(runtimeRepairIndex);
tamperedRuntimeIndex.pages[0].blocks[0].asset_path = "images/forged.jpg";
assert.ok(visualRepair.validateVisualContracts({
	viewerIndex: tamperedRuntimeIndex,
	visualRepair: runtimeRepairPlan,
	sourceIndex: runtimeRepairIndex,
	articleHash: runtimeArticleHash,
	mineruHash: runtimeMineruHash,
}).some((error) => error.includes("来源绑定不一致")));
const tamperedCaptionIndex = structuredClone(runtimeRepairIndex);
tamperedCaptionIndex.pages[0].blocks[0].caption.text = "伪造图注";
assert.ok(visualRepair.validateVisualContracts({
	viewerIndex: tamperedCaptionIndex,
	visualRepair: runtimeRepairPlan,
	sourceIndex: runtimeRepairIndex,
	articleHash: runtimeArticleHash,
	mineruHash: runtimeMineruHash,
}).some((error) => error.includes("块来源绑定不一致")));
const incompleteMemberMapping = structuredClone(runtimeRepairPlan);
incompleteMemberMapping.groups[0].member_markdown_image_ids.pop();
assert.ok(visualRepair.validateVisualContracts({
	viewerIndex: runtimeRepairIndex,
	visualRepair: incompleteMemberMapping,
	sourceIndex: runtimeRepairIndex,
	articleHash: runtimeArticleHash,
	mineruHash: runtimeMineruHash,
}).some((error) => error.includes("未精确绑定成员")));

assert.throws(
	() => normalization.buildRuntimeViewerIndex(
		Array.from({ length: 8193 }, (_value, index) => ({ type: "text", page_idx: index })),
		"# Too many",
	),
	/元素数超过/,
);
assert.throws(
	() => normalization.buildRuntimeViewerIndex(
		[{ type: "text", page_idx: 2048, bbox: [1, 1, 10, 10], text: "out of range" }],
		"# Invalid page",
	),
	/page_idx/,
);
assert.throws(
	() => normalization.buildRuntimeViewerIndex([], Array.from(
		{ length: 4097 },
		(_value, index) => `![](images/${index}.png)`,
	).join("\n")),
	/图片引用数超过/,
);

const isolatedRepairIndex = normalization.buildRuntimeViewerIndex([
	{ type: "image", page_idx: 0, bbox: [50, 50, 200, 200], img_path: "images/left.jpg" },
	{ type: "image", page_idx: 0, bbox: [700, 700, 900, 900], img_path: "images/right.jpg" },
], "![](images/left.jpg)\n\n![](images/right.jpg)\n");
assert.equal(visualRepair.buildRuntimeVisualRepair(isolatedRepairIndex).groups.length, 0);
assert.equal(normalization.classifyCaptionPart("(a)"), "panel-label");
assert.equal(normalization.classifyCaptionPart("a-d"), "other");
assert.equal(
	normalization.classifyCaptionPart("lowercase caption continuation that ends safely."),
	"caption-continuation",
);
assert.equal(
	normalization.classifyCaptionPart("lowercase caption continuation without a terminator"),
	"other",
);
assert.equal(
	normalization.figureKeyFromText("Extended Data Fig. 3 | Formal caption"),
	"extended-data-figure:3",
);
assert.equal(
	normalization.formalFigureCaptionKeyFromText("Extended\u00a0Data Figure 1 ｜\u202fFormal caption"),
	"extended-data-figure:1",
);
assert.equal(
	normalization.formalFigureCaptionKeyFromText("Extended Data Fig. 1 |\u00a0A language model of the human metabolome."),
	"extended-data-figure:1",
);
const pollutedNextPageAtom = "q r Extended Data Fig. 3 | See next page for caption.";
assert.equal(normalization.classifyCaptionPart(pollutedNextPageAtom), "other");
assert.equal(
	normalization.nextPageCaptionPlaceholderFromText(
		pollutedNextPageAtom,
		"extended-data-figure:3",
	),
	"Extended Data Fig. 3 | See next page for caption.",
);
assert.equal(
	normalization.nextPageCaptionPlaceholderFromText(
		"Extended Data Fig. 4 | See next page for caption. p q",
		"extended-data-figure:4",
	),
	"Extended Data Fig. 4 | See next page for caption.",
);
assert.equal(
	normalization.nextPageCaptionPlaceholderFromText(
		"Fig. 2 | See next page for details",
		"figure:2",
	),
	"",
);
const trailingProsePlaceholderCandidate = "q r Extended Data Fig. 3 | See next page for caption and other prose.";
assert.equal(normalization.classifyCaptionPart(trailingProsePlaceholderCandidate), "other");
assert.equal(
	normalization.nextPageCaptionPlaceholderFromText(
		trailingProsePlaceholderCandidate,
		"extended-data-figure:3",
	),
	"",
);
assert.equal(
	normalization.classifyCaptionPart("Fig. 5 | See next page for caption and other prose."),
	"other",
);
const pollutedPlaceholderIndex = normalization.buildRuntimeViewerIndex(
	[{
		type: "image",
		page_idx: 23,
		bbox: [50, 50, 950, 700],
		img_path: "images/ext3.jpg",
		image_caption: ["q", "r", "Extended Data Fig. 3 | See next page for caption."],
	}],
	"![](images/ext3.jpg)\n",
);
assert.deepEqual(
	pollutedPlaceholderIndex.pages[0].blocks[0].caption.figure_keys,
	["extended-data-figure:3"],
);
assert.deepEqual(
	pollutedPlaceholderIndex.pages[0].blocks[0].caption.next_page_figure_keys,
	["extended-data-figure:3"],
);
assert.deepEqual(
	pollutedPlaceholderIndex.pages[0].blocks[0].caption.parts.map((part) => [part.text, part.kind]),
	[
		["q", "panel-label"],
		["r", "panel-label"],
		["Extended Data Fig. 3 | See next page for caption.", "next-page-placeholder"],
	],
);
const crossPagePlaceholder = "Fig. 2 | See next page for caption";
const crossPageFormalText = "Fig. 2 | Formal caption on the following page";
const crossPageTargetBody = "Target-page body anchor that must remain visible.";
const crossPageArticle = [
	"![](images/cross-page.jpg)",
	crossPagePlaceholder,
	"Body paragraph between the source and target pages.",
	crossPageFormalText,
	crossPageTargetBody,
	"![](images/cross-page-after.jpg)",
].join("\n") + "\n";
const crossPageIndex = normalization.buildRuntimeViewerIndex(
	[
		{
			type: "image",
			page_idx: 3,
			bbox: [50, 50, 950, 700],
			img_path: "images/cross-page.jpg",
			image_caption: [crossPagePlaceholder],
		},
		{
			type: "text",
			page_idx: 4,
			bbox: [50, 50, 490, 240],
			text: crossPageFormalText,
		},
		{
			type: "text",
			page_idx: 4,
			bbox: [50, 260, 490, 360],
			text: crossPageTargetBody,
		},
		{
			type: "image",
			page_idx: 4,
			bbox: [50, 400, 950, 900],
			img_path: "images/cross-page-after.jpg",
		},
	],
	crossPageArticle,
);
assert.deepEqual(crossPageIndex.pages[0].blocks[0].caption.figure_keys, ["figure:2"]);
assert.equal(crossPageIndex.pages[0].blocks[0].caption.next_page_reference_count, 1);
assert.deepEqual(crossPageIndex.pages[1].blocks[0].text.figure_keys, ["figure:2"]);
assert.equal(crossPageIndex.pages[1].blocks[0].text.text, "Fig. 2 | Formal caption on the following page");
assert.deepEqual(crossPageIndex.pages[0].blocks[0].caption.next_page_placeholders, [{
	index: 0,
	text: crossPagePlaceholder,
	figure_key: "figure:2",
}]);
assert.deepEqual(crossPageIndex.pages[1].blocks[0].markdown_text_range, {
	offset_unit: "utf16-code-unit",
	start: crossPageArticle.indexOf(crossPageFormalText),
	end: crossPageArticle.indexOf(crossPageFormalText) + crossPageFormalText.length + 1,
});
const crossPageBlocks = crossPageIndex.pages.flatMap((page) => page.blocks);
const crossPageLink = {
	visual_block_id: crossPageIndex.pages[0].blocks[0].id,
	caption_block_ids: [crossPageIndex.pages[1].blocks[0].id],
	source_page_idx: 3,
	target_page_idx: 4,
	figure_key: "figure:2",
	relation: "next_page_figure_caption",
	status: "partial",
};
const resolvedCrossPageCaption = markdown.resolveVisualCaptionDetails(
	[crossPageIndex.pages[0].blocks[0]],
	crossPageBlocks,
	{
		schema_version: 1,
		algorithm_version: "visual-repair-v1.3",
		status: "complete",
		groups: [],
		caption_links: [crossPageLink],
		issues: [],
	},
	3,
);
assert.equal(resolvedCrossPageCaption.caption, "Fig. 2 | Formal caption on the following page");
assert.deepEqual(resolvedCrossPageCaption.captionSourceBlockIds, [crossPageIndex.pages[1].blocks[0].id]);
assert.equal(resolvedCrossPageCaption.captionPageIdx, 4);
assert.equal(resolvedCrossPageCaption.captionStatus, "partial");
assert.deepEqual(resolvedCrossPageCaption.pageRange, [3, 4]);
assert.deepEqual(resolvedCrossPageCaption.captionSourceProjections, [{
	start: crossPageArticle.indexOf(crossPageFormalText),
	end: crossPageArticle.indexOf(crossPageFormalText) + crossPageFormalText.length + 1,
	text: crossPageFormalText,
	suppress: true,
}, {
	start: crossPageArticle.indexOf(crossPageTargetBody),
	end: crossPageArticle.indexOf(crossPageTargetBody) + crossPageTargetBody.length + 1,
	text: crossPageTargetBody,
	suppress: false,
}]);
assert.deepEqual(resolvedCrossPageCaption.captionSourceImageBounds, {
	beforeMarkdownImageId: "md-img-0000",
	afterMarkdownImageId: "md-img-0001",
});
assert.equal(markdown.captionLinkMatchesBlocks(
	crossPageLink,
	crossPageIndex.pages[0].blocks[0],
	crossPageIndex.pages[1].blocks,
), true);
assert.equal(markdown.captionLinkMatchesBlocks(
	crossPageLink,
	{
		...crossPageIndex.pages[0].blocks[0],
		caption: {
			...crossPageIndex.pages[0].blocks[0].caption,
			next_page_placeholders: [],
		},
	},
	crossPageIndex.pages[1].blocks,
), false);

const ext8Placeholder = "Extended Data Fig. 8 | See next page for caption.";
const ext8Formal = "Extended Data Fig. 8 | Examples of incorrect predictions. From left to right, panels show a prediction that";
const ext8Continuation = "affords a partial match by MS/MS, but a key fragment is missing.";
const ext8Index = normalization.buildRuntimeViewerIndex(
	[
		{ type: "header", page_idx: 31, bbox: [62, 31, 147, 51], text: "Article" },
		{
			type: "chart",
			page_idx: 32,
			bbox: [139, 59, 875, 889],
			img_path: "images/ext8.jpg",
			chart_caption: [ext8Placeholder],
		},
		{ type: "text", page_idx: 33, bbox: [62, 31, 147, 50], text: "Article" },
		{ type: "text", page_idx: 33, bbox: [60, 56, 497, 225], text: ext8Formal },
		{ type: "text", page_idx: 33, bbox: [509, 59, 944, 212], text: ext8Continuation },
	],
	["![](images/ext8.jpg)", ext8Placeholder, ext8Formal, ext8Continuation].join("\n") + "\n",
);
const ext8Blocks = ext8Index.pages.flatMap((page) => page.blocks);
const ext8Header = ext8Index.pages.find((page) => page.page_idx === 31).blocks[0];
const ext8FalseTextHeader = ext8Index.pages.find((page) => page.page_idx === 33).blocks[0];
const ext8Visual = ext8Index.pages.find((page) => page.page_idx === 32).blocks[0];
assert.equal(ext8Header.role, "discarded");
assert.equal(ext8Header.text.text, "Article");
assert.equal(ext8FalseTextHeader.role, "discarded");
const inferredExt8Link = markdown.inferRuntimeNextPageCaptionLink([ext8Visual], ext8Blocks, 32);
assert.deepEqual(inferredExt8Link, {
	visual_block_id: ext8Visual.id,
	caption_block_ids: [
		ext8Index.pages.find((page) => page.page_idx === 33).blocks[1].id,
		ext8Index.pages.find((page) => page.page_idx === 33).blocks[2].id,
	],
	source_page_idx: 32,
	target_page_idx: 33,
	figure_key: "extended-data-figure:8",
	relation: "next_page_figure_caption",
	status: "complete",
});
const inferredExt8Details = markdown.resolveVisualCaptionDetails(
	[ext8Visual],
	ext8Blocks,
	{
		schema_version: 1,
		algorithm_version: "visual-repair-v1.4",
		status: "complete",
		groups: [],
		caption_links: [],
		issues: [],
	},
	32,
);
assert.equal(inferredExt8Details.caption, `${ext8Formal} ${ext8Continuation}`);
assert.deepEqual(inferredExt8Details.captionSourceBlockIds, inferredExt8Link.caption_block_ids);
assert.deepEqual(inferredExt8Details.pageRange, [32, 33]);
const inferredExt8WithoutRepair = markdown.resolveVisualCaptionDetails(
	[ext8Visual],
	ext8Blocks,
	null,
	32,
);
assert.equal(inferredExt8WithoutRepair.caption, `${ext8Formal} ${ext8Continuation}`);
assert.deepEqual(inferredExt8WithoutRepair.captionSourceBlockIds, inferredExt8Link.caption_block_ids);

const boundedHeaderMarkdown = [
	"![](images/header-before.jpg)",
	"",
	"## Article",
	"",
	"![](images/header-after.jpg)",
	"",
	"## Article",
].join("\n") + "\n";
const boundedHeaderIndex = normalization.buildRuntimeViewerIndex(
	[
		{ type: "header", page_idx: 31, bbox: [62, 31, 147, 51], text: "Article" },
		{ type: "image", page_idx: 32, bbox: [80, 100, 920, 700], img_path: "images/header-before.jpg" },
		{ type: "text", page_idx: 33, bbox: [62, 31, 147, 50], text: "Article" },
		{ type: "image", page_idx: 33, bbox: [80, 100, 920, 700], img_path: "images/header-after.jpg" },
	],
	boundedHeaderMarkdown,
);
const boundedHeaderBlocks = boundedHeaderIndex.pages.flatMap((page) => page.blocks);
const boundedFalseHeader = boundedHeaderIndex.pages.find((page) => page.page_idx === 33).blocks[0];
const boundedAfterVisual = boundedHeaderIndex.pages.find((page) => page.page_idx === 33).blocks[1];
assert.equal(boundedFalseHeader.role, "discarded");
const boundedHeaderDetails = markdown.resolveVisualCaptionDetails(
	[boundedAfterVisual],
	boundedHeaderBlocks,
	null,
	33,
);
assert.deepEqual(boundedHeaderDetails.boundedHeadingProjections, [{
	text: "Article",
	before: { kind: "image", markdownImageId: "md-img-0000" },
	after: { kind: "image", markdownImageId: "md-img-0001" },
}]);
const boundedHeaderVisual = {
	id: "bounded-running-header",
	pageIdx: 33,
	label: "图像 1",
	...boundedHeaderDetails,
	memberBlockIds: [boundedAfterVisual.id],
	memberAssetPaths: ["images/header-after.jpg"],
	memberMarkdownImageIds: ["md-img-0001"],
	anchorAssetPath: "images/header-after.jpg",
	display: { mode: "asset", assetPath: "images/header-after.jpg" },
	repairDecision: "keep-original",
	confidence: 1,
};
const boundedHeaderPrepared = markdown.prepareReaderMarkdown(
	boundedHeaderMarkdown,
	[boundedHeaderVisual],
);
assert.equal((boundedHeaderPrepared.match(/^## Article$/gm) || []).length, 1);
assert.ok(boundedHeaderPrepared.trimEnd().endsWith("## Article"));
const ambiguousBoundedHeaderMarkdown = boundedHeaderMarkdown.replace(
	"## Article\n\n![](images/header-after.jpg)",
	"## Article\n\n## Article\n\n![](images/header-after.jpg)",
);
const ambiguousBoundedHeaderPrepared = markdown.prepareReaderMarkdown(
	ambiguousBoundedHeaderMarkdown,
	[boundedHeaderVisual],
);
assert.equal((ambiguousBoundedHeaderPrepared.match(/^## Article$/gm) || []).length, 3);

const boundedHeaderTableHtml = '<table><tr><td><img src="images/header-cell.jpg"/></td></tr></table>';
const boundedHeaderTableMarkdown = [
	"![](images/header-table-before.jpg)",
	"",
	"## Article",
	"",
	boundedHeaderTableHtml,
].join("\n") + "\n";
const boundedHeaderTableIndex = normalization.buildRuntimeViewerIndex(
	[
		{ type: "header", page_idx: 31, bbox: [62, 31, 147, 51], text: "Article" },
		{ type: "image", page_idx: 34, bbox: [80, 100, 920, 700], img_path: "images/header-table-before.jpg" },
		{ type: "text", page_idx: 35, bbox: [62, 31, 147, 50], text: "Article" },
		{
			type: "table",
			page_idx: 35,
			bbox: [63, 55, 495, 349],
			img_path: "images/header-table.jpg",
			table_body: boundedHeaderTableHtml,
		},
	],
	boundedHeaderTableMarkdown,
);
const boundedHeaderTableBlocks = boundedHeaderTableIndex.pages.flatMap((page) => page.blocks);
const boundedHeaderTable = boundedHeaderTableIndex.pages.find((page) => page.page_idx === 35).blocks[1];
const boundedHeaderTableDetails = markdown.resolveVisualCaptionDetails(
	[boundedHeaderTable],
	boundedHeaderTableBlocks,
	null,
	35,
);
assert.deepEqual(boundedHeaderTableDetails.boundedHeadingProjections, [{
	text: "Article",
	before: { kind: "image", markdownImageId: "md-img-0000" },
	after: {
		kind: "table",
		markdownTableRange: {
			offset_unit: "utf16-code-unit",
			start: boundedHeaderTableMarkdown.indexOf(boundedHeaderTableHtml),
			end: boundedHeaderTableMarkdown.indexOf(boundedHeaderTableHtml) + boundedHeaderTableHtml.length,
		},
	},
}]);
const boundedHeaderTablePrepared = markdown.prepareReaderMarkdown(
	boundedHeaderTableMarkdown,
	[{
		id: "bounded-running-header-table",
		pageIdx: 35,
		label: "图像 2",
		...boundedHeaderTableDetails,
		memberBlockIds: [boundedHeaderTable.id],
		memberAssetPaths: ["images/header-table.jpg"],
		memberMarkdownImageIds: [],
		anchorAssetPath: "images/header-table.jpg",
		display: { mode: "asset", assetPath: "images/header-table.jpg" },
		repairDecision: "keep-original",
		confidence: 1,
	}],
);
assert.ok(!boundedHeaderTablePrepared.includes("## Article"));
assert.ok(boundedHeaderTablePrepared.includes(boundedHeaderTableHtml));

const mismatchedHeaderBboxIndex = normalization.buildRuntimeViewerIndex(
	[
		{ type: "header", page_idx: 31, bbox: [62, 31, 147, 51], text: "Article" },
		{
			type: "chart",
			page_idx: 32,
			bbox: [139, 59, 875, 889],
			img_path: "images/ext8.jpg",
			chart_caption: [ext8Placeholder],
		},
		{ type: "text", page_idx: 33, bbox: [300, 31, 385, 50], text: "Article" },
		{ type: "text", page_idx: 33, bbox: [60, 56, 497, 225], text: ext8Formal },
	],
	"![](images/ext8.jpg)\n",
);
const mismatchedBlocks = mismatchedHeaderBboxIndex.pages.flatMap((page) => page.blocks);
assert.equal(mismatchedHeaderBboxIndex.pages.find((page) => page.page_idx === 33).blocks[0].role, "text");
assert.equal(markdown.inferRuntimeNextPageCaptionLink(
	[mismatchedHeaderBboxIndex.pages.find((page) => page.page_idx === 32).blocks[0]],
	mismatchedBlocks,
	32,
), null);

const invalidStoredExt8 = markdown.resolveVisualCaptionDetails(
	[ext8Visual],
	ext8Blocks,
	{
		schema_version: 1,
		algorithm_version: "visual-repair-v1.4",
		status: "complete",
		groups: [],
		caption_links: [{
			...inferredExt8Link,
			caption_block_ids: [inferredExt8Link.caption_block_ids[0]],
			status: "partial",
		}],
		issues: [],
	},
	32,
);
assert.deepEqual(invalidStoredExt8.captionSourceBlockIds, []);

const duplicateExt8Source = {
	...ext8Visual,
	id: "p0032-s999999",
	source_index: 999999,
	page_order: ext8Visual.page_order + 1,
};
assert.equal(markdown.inferRuntimeNextPageCaptionLink(
	[ext8Visual, duplicateExt8Source],
	[...ext8Blocks, duplicateExt8Source],
	32,
), null);
const ambiguousGroupDetails = markdown.resolveVisualCaptionDetails(
	[ext8Visual, duplicateExt8Source],
	[...ext8Blocks, duplicateExt8Source],
	{
		schema_version: 1,
		algorithm_version: "visual-repair-v1.4",
		status: "complete",
		groups: [],
		caption_links: [],
		issues: [],
	},
	32,
);
assert.deepEqual(ambiguousGroupDetails.captionSourceBlockIds, []);

const ordinaryReferenceTarget = {
	...crossPageIndex.pages[1].blocks[0],
	text: {
		...crossPageIndex.pages[1].blocks[0].text,
		text: "Fig. 2 shows the model performance in the held-out set.",
	},
};
assert.equal(markdown.captionLinkMatchesBlocks(
	crossPageLink,
	crossPageIndex.pages[0].blocks[0],
	[ordinaryReferenceTarget],
), false);
const rejectedOrdinaryCaption = markdown.resolveVisualCaptionDetails(
	[crossPageIndex.pages[0].blocks[0]],
	[crossPageIndex.pages[0].blocks[0], ordinaryReferenceTarget],
	{
		schema_version: 1,
		algorithm_version: "visual-repair-v1.4",
		status: "complete",
		groups: [],
		caption_links: [crossPageLink],
		issues: [],
	},
	3,
);
assert.equal(rejectedOrdinaryCaption.caption, "Fig. 2 | See next page for caption");
assert.deepEqual(rejectedOrdinaryCaption.captionSourceBlockIds, []);

const terminalAnchor = {
	...crossPageIndex.pages[1].blocks[0],
	text: {
		...crossPageIndex.pages[1].blocks[0].text,
		text: "Fig. 2 | A complete formal caption.",
	},
};
const adjacentBody = {
	...terminalAnchor,
	id: "p0004-s000002",
	source_index: 2,
	page_order: 1,
	bbox_norm: [510, 50, 950, 240],
	text: {
		...terminalAnchor.text,
		text: "body prose that must remain outside the completed caption.",
		leading_figure_key: undefined,
		figure_keys: [],
	},
};
const terminalLink = {
	...crossPageLink,
	caption_block_ids: [terminalAnchor.id],
	status: "complete",
};
assert.equal(markdown.captionLinkMatchesBlocks(
	terminalLink,
	crossPageIndex.pages[0].blocks[0],
	[terminalAnchor, adjacentBody],
), true);
assert.equal(markdown.captionLinkMatchesBlocks(
	{ ...terminalLink, caption_block_ids: [terminalAnchor.id, adjacentBody.id] },
	crossPageIndex.pages[0].blocks[0],
	[terminalAnchor, adjacentBody],
), false);

const bodyBeforeAnchor = {
	...adjacentBody,
	id: "p0004-s000000",
	source_index: 0,
	page_order: 0,
	bbox_norm: [50, 40, 950, 48],
	text: { ...adjacentBody.text, text: "Ordinary body before a repeated Fig. 2 caption." },
};
const laterAnchor = {
	...terminalAnchor,
	id: "p0004-s000003",
	source_index: 3,
	page_order: 1,
};
assert.equal(markdown.captionLinkMatchesBlocks(
	{ ...terminalLink, caption_block_ids: [laterAnchor.id] },
	crossPageIndex.pages[0].blocks[0],
	[bodyBeforeAnchor, laterAnchor],
), false);
const rejectedMiddlePageCaption = markdown.resolveVisualCaptionDetails(
	[crossPageIndex.pages[0].blocks[0]],
	[crossPageIndex.pages[0].blocks[0], bodyBeforeAnchor, laterAnchor],
	{
		schema_version: 1,
		algorithm_version: "visual-repair-v1.4",
		status: "complete",
		groups: [],
		caption_links: [{ ...terminalLink, caption_block_ids: [laterAnchor.id] }],
		issues: [],
	},
	3,
);
assert.deepEqual(rejectedMiddlePageCaption.captionSourceBlockIds, []);
assert.deepEqual(rejectedMiddlePageCaption.captionSourceProjections, []);
const visualBeforeAnchor = {
	...crossPageIndex.pages[0].blocks[0],
	id: "p0004-s000000-visual",
	source_index: 0,
	page_order: 0,
};
assert.equal(markdown.captionLinkMatchesBlocks(
	{ ...terminalLink, caption_block_ids: [laterAnchor.id] },
	crossPageIndex.pages[0].blocks[0],
	[visualBeforeAnchor, laterAnchor],
), false);

const continuationAnchor = {
	...terminalAnchor,
	text: { ...terminalAnchor.text, text: "Fig. 2 | A caption that continues" },
};
const safeContinuation = {
	...adjacentBody,
	text: { ...adjacentBody.text, text: "k, final panel description." },
};
const continuationLink = {
	...crossPageLink,
	caption_block_ids: [continuationAnchor.id, safeContinuation.id],
	status: "complete",
};
assert.equal(markdown.captionLinkMatchesBlocks(
	continuationLink,
	crossPageIndex.pages[0].blocks[0],
	[continuationAnchor, safeContinuation],
), true);
assert.equal(markdown.captionLinkMatchesBlocks(
	{ ...continuationLink, status: "partial" },
	crossPageIndex.pages[0].blocks[0],
	[continuationAnchor, safeContinuation],
), false);
const unterminatedContinuation = {
	...safeContinuation,
	text: { ...safeContinuation.text, text: "k, panel description continues" },
};
assert.equal(markdown.captionLinkMatchesBlocks(
	{
		...continuationLink,
		caption_block_ids: [continuationAnchor.id, unterminatedContinuation.id],
		status: "partial",
	},
	crossPageIndex.pages[0].blocks[0],
	[continuationAnchor, unterminatedContinuation],
), true);

const mergedCrossPageAnchor = "Fig. 2 | A long caption sentence. j, ROC curve showing";
const mergedBodyPrefix = "The body experiment correctly assigned ";
const recoveredCaptionTail = "prioritization of HMDB 5.0 metabolites by sampling frequency. k, Enrichment among frequent molecules. l, Proportion in HMDB.";
const mergedCaptionMarkdown = [
	"![](images/fig2-merged.jpg)",
	"",
	mergedCrossPageAnchor,
	"",
	"Ordinary body with a Fig. 2k reference that must stay visible.",
	"",
	`${mergedBodyPrefix}${recoveredCaptionTail}`,
	"",
	"![](images/following-merged.jpg)",
	"",
].join("\n");
const mergedCaptionIndex = normalization.buildRuntimeViewerIndex(
	[
		{
			type: "image",
			page_idx: 3,
			bbox: [60, 60, 947, 772],
			img_path: "images/fig2-merged.jpg",
			image_caption: ["Fig. 2 | See next page for caption"],
		},
		{ type: "text", page_idx: 4, bbox: [60, 59, 497, 250], text: mergedCrossPageAnchor },
		{
			type: "text",
			page_idx: 4,
			bbox: [60, 275, 497, 358],
			text: "Ordinary body with a Fig. 2k reference that must stay visible.",
		},
		{
			type: "text",
			page_idx: 4,
			bbox: [60, 874, 497, 943],
			text: `${mergedBodyPrefix}${recoveredCaptionTail}`,
		},
		{ type: "text", page_idx: 4, bbox: [507, 59, 944, 237], text: "" },
		{
			type: "image",
			page_idx: 5,
			bbox: [60, 60, 940, 700],
			img_path: "images/following-merged.jpg",
		},
	],
	mergedCaptionMarkdown,
);
const mergedCaptionBlocks = mergedCaptionIndex.pages.flatMap((page) => page.blocks);
const mergedCaptionSource = mergedCaptionBlocks[0];
const mergedCaptionRepair = {
	schema_version: 1,
	algorithm_version: "visual-repair-v1.6",
	status: "partial",
	groups: [],
	caption_links: [{
		visual_block_id: mergedCaptionSource.id,
		caption_block_ids: [mergedCaptionBlocks[1].id],
		source_page_idx: 3,
		target_page_idx: 4,
		figure_key: "figure:2",
		relation: "next_page_figure_caption",
		status: "partial",
	}],
	issues: [],
};
const mergedCaptionDetails = markdown.resolveVisualCaptionDetails(
	[mergedCaptionSource],
	mergedCaptionBlocks,
	mergedCaptionRepair,
	3,
);
const mergedCaptionVisuals = [{
	id: "merged-cross-page-caption",
	pageIdx: 3,
	label: "Fig. 2",
	...mergedCaptionDetails,
	memberBlockIds: [mergedCaptionSource.id],
	memberAssetPaths: ["images/fig2-merged.jpg"],
	memberMarkdownImageIds: ["md-img-0000"],
	anchorAssetPath: "images/fig2-merged.jpg",
	display: { mode: "asset", assetPath: "images/fig2-merged.jpg" },
	repairDecision: "keep-original",
	confidence: 1,
}];
const mergedRegions = markdown.pdfCaptionContinuationRegions(
	mergedCaptionVisuals,
	mergedCaptionIndex,
);
assert.deepEqual(mergedRegions, [{
	visualId: "merged-cross-page-caption",
	sourceBlockId: mergedCaptionBlocks[4].id,
	pageNumber: 5,
	bbox: [507, 59, 944, 237],
}]);
const terminalMergedVisuals = structuredClone(mergedCaptionVisuals);
terminalMergedVisuals[0].captionStatus = "complete";
assert.equal(markdown.pdfCaptionContinuationRegions(
	terminalMergedVisuals,
	mergedCaptionIndex,
).length, 1);
assert.equal(markdown.applyPdfCaptionContinuationRecovery(
	mergedCaptionMarkdown,
	mergedCaptionVisuals,
	mergedCaptionIndex,
	[{ ...mergedRegions[0], text: recoveredCaptionTail }],
), 1);
assert.equal(mergedCaptionVisuals[0].captionStatus, "complete");
assert.ok(mergedCaptionVisuals[0].caption.endsWith(recoveredCaptionTail));
const recoveredCaptionPrepared = markdown.prepareReaderMarkdown(
	mergedCaptionMarkdown,
	mergedCaptionVisuals,
	mergedCaptionIndex,
);
assert.ok(recoveredCaptionPrepared.includes(mergedBodyPrefix.trim()));
assert.ok(recoveredCaptionPrepared.includes("Fig. 2k reference that must stay visible"));
assert.ok(!recoveredCaptionPrepared.includes(recoveredCaptionTail));
const noPanelRecoveryVisuals = structuredClone(mergedCaptionVisuals);
noPanelRecoveryVisuals[0].captionInlineProjections = [];
noPanelRecoveryVisuals[0].captionStatus = "partial";
assert.equal(markdown.applyPdfCaptionContinuationRecovery(
	mergedCaptionMarkdown,
	noPanelRecoveryVisuals,
	mergedCaptionIndex,
	[{ ...mergedRegions[0], text: "ordinary lowercase body prose with Table 2 and Fig. 2k references." }],
), 0);

const fixtureWorkspaceRoot = String(process.env.AGENT_DASHBOARD_FIXTURE_WORKSPACE || "").trim();
const qiangPackageRoot = path.join(fixtureWorkspaceRoot, "knowledge-base/papers/qiang_language_2026");
const blampeyPackageRoot = path.join(fixtureWorkspaceRoot, "knowledge-base/papers/blampey_novae_2025");
if (
	fixtureWorkspaceRoot
	&& fs.existsSync(path.join(qiangPackageRoot, "article.md"))
	&& fs.existsSync(path.join(blampeyPackageRoot, "article.md"))
) {
const qiangArticle = fs.readFileSync(path.join(qiangPackageRoot, "article.md"), "utf8");
const qiangPayload = JSON.parse(fs.readFileSync(path.join(qiangPackageRoot, "mineru-result.json"), "utf8"));
const qiangRepair = JSON.parse(fs.readFileSync(
	path.join(qiangPackageRoot, "_extraction/visual-repair.json"),
	"utf8",
));
const qiangIndex = normalization.buildRuntimeViewerIndex(qiangPayload, qiangArticle);
const qiangBlocks = qiangIndex.pages.flatMap((page) => page.blocks);
const qiangSource = qiangBlocks.find((block) => block.id === "p0003-s000058");
assert.ok(qiangSource);
const qiangDetails = markdown.resolveVisualCaptionDetails(
	[qiangSource],
	qiangBlocks,
	qiangRepair,
	3,
);
const qiangVisuals = [{
	id: "qiang-fig-2",
	pageIdx: 3,
	label: "Fig. 2",
	...qiangDetails,
	memberBlockIds: [qiangSource.id],
	memberAssetPaths: [qiangSource.asset_path],
	memberMarkdownImageIds: [...qiangSource.markdown_image_ids],
	anchorAssetPath: qiangSource.asset_path,
	display: { mode: "asset", assetPath: qiangSource.asset_path },
	repairDecision: "keep-original",
	confidence: 1,
}];
const qiangRegions = markdown.pdfCaptionContinuationRegions(qiangVisuals, qiangIndex);
assert.equal(qiangRegions.length, 1);
assert.equal(qiangRegions[0].sourceBlockId, "p0004-s000075");
const qiangMergedLine = qiangArticle.split(/\r?\n/).find((line) =>
	line.includes("prioritization of HMDB 5.0 metabolites on the basis"),
);
assert.ok(qiangMergedLine);
const qiangTailStart = qiangMergedLine.indexOf("prioritization of HMDB 5.0 metabolites on the basis");
const qiangTail = qiangMergedLine.slice(qiangTailStart);
assert.equal(markdown.applyPdfCaptionContinuationRecovery(
	qiangArticle,
	qiangVisuals,
	qiangIndex,
	[{ ...qiangRegions[0], text: qiangTail }],
), 1);
const qiangPrepared = markdown.prepareReaderMarkdown(qiangArticle, qiangVisuals, qiangIndex);
assert.ok(qiangPrepared.includes("To test this possibility, we applied CFM-ID"));
assert.ok(!qiangPrepared.includes("prioritization of HMDB 5.0 metabolites on the basis"));
assert.ok(qiangVisuals[0].caption.includes("k, Enrichment of HMDB 5.0 metabolites"));
const qiangPdfJsVisuals = structuredClone([{
	id: "qiang-fig-2-pdfjs",
	pageIdx: 3,
	label: "Fig. 2",
	...qiangDetails,
	memberBlockIds: [qiangSource.id],
	memberAssetPaths: [qiangSource.asset_path],
	memberMarkdownImageIds: [...qiangSource.markdown_image_ids],
	anchorAssetPath: qiangSource.asset_path,
	display: { mode: "asset", assetPath: qiangSource.asset_path },
	repairDecision: "keep-original",
	confidence: 1,
}]);
const qiangPdfJsRegion = markdown.pdfCaptionContinuationRegions(qiangPdfJsVisuals, qiangIndex)[0];
const qiangPdfJsText = qiangTail
	.replace("sampling frequencies", "sampling fre-\nquencies")
	.replace("two-sided χ<sup>2</sup>", "two-sided χ 2")
	.replace(/\u00a0/g, " ");
assert.equal(markdown.applyPdfCaptionContinuationRecovery(
	qiangArticle,
	qiangPdfJsVisuals,
	qiangIndex,
	[{ ...qiangPdfJsRegion, text: qiangPdfJsText }],
), 1);
const qiangPdfJsPrepared = markdown.prepareReaderMarkdown(qiangArticle, qiangPdfJsVisuals, qiangIndex);
assert.ok(qiangPdfJsPrepared.includes("To test this possibility, we applied CFM-ID"));
assert.ok(!qiangPdfJsPrepared.includes("prioritization of HMDB 5.0 metabolites on the basis"));
assert.ok(qiangPdfJsVisuals[0].caption.includes("two-sided χ<sup>2</sup>"));

const blampeyArticle = fs.readFileSync(path.join(blampeyPackageRoot, "article.md"), "utf8");
const blampeyPayload = JSON.parse(fs.readFileSync(
	path.join(blampeyPackageRoot, "mineru-result.json"),
	"utf8",
));
const blampeyRepair = JSON.parse(fs.readFileSync(
	path.join(blampeyPackageRoot, "_extraction/visual-repair.json"),
	"utf8",
));
const blampeyIndex = normalization.buildRuntimeViewerIndex(blampeyPayload, blampeyArticle);
const blampeyBlocks = blampeyIndex.pages.flatMap((page) => page.blocks);
const blampeyGroup = blampeyRepair.groups.find((group) => group.id === "vr-p0004-g0000");
assert.ok(blampeyGroup);
const blampeyMembers = blampeyGroup.member_block_ids.map((id) =>
	blampeyBlocks.find((block) => block.id === id),
).filter(Boolean);
assert.equal(blampeyMembers.length, blampeyGroup.member_block_ids.length);
const blampeyDetails = markdown.resolveVisualCaptionDetails(
	blampeyMembers,
	blampeyBlocks,
	blampeyRepair,
	4,
);
const blampeyVisuals = [{
	id: blampeyGroup.id,
	pageIdx: 4,
	label: "Fig. 3",
	...blampeyDetails,
	memberBlockIds: [...blampeyGroup.member_block_ids],
	memberAssetPaths: [...blampeyGroup.member_asset_paths],
	memberMarkdownImageIds: [...blampeyGroup.member_markdown_image_ids],
	anchorAssetPath: blampeyGroup.replacement.asset_path,
	display: { mode: "asset", assetPath: blampeyGroup.replacement.asset_path },
	repairDecision: blampeyGroup.decision,
	confidence: blampeyGroup.confidence,
}];
const blampeyRegions = markdown.pdfCaptionContinuationRegions(blampeyVisuals, blampeyIndex);
assert.equal(blampeyRegions.length, 1);
assert.equal(blampeyRegions[0].sourceBlockId, "p0004-s000066");
assert.equal(blampeyRegions[0].pageNumber, 5);
const blampeyMergedLine = blampeyArticle.split(/\r?\n/).find((line) =>
	line.startsWith("After running inference"),
);
assert.ok(blampeyMergedLine);
const blampeyTailStart = blampeyMergedLine.indexOf("dataset (MERSCOPE and Xenium slides");
assert.ok(blampeyTailStart > 0);
const blampeyTail = blampeyMergedLine.slice(blampeyTailStart);
assert.equal(markdown.applyPdfCaptionContinuationRecovery(
	blampeyArticle,
	blampeyVisuals,
	blampeyIndex,
	[{ ...blampeyRegions[0], text: blampeyTail }],
), 1);
const blampeyPrepared = markdown.prepareReaderMarkdown(
	blampeyArticle,
	blampeyVisuals,
	blampeyIndex,
);
assert.ok(blampeyPrepared.includes("After running inference"));
assert.ok(blampeyPrepared.includes("it is common to try multiple resolutions of spatial domains, hence"));
assert.ok(!blampeyPrepared.includes("dataset (MERSCOPE and Xenium slides, see more details"));
assert.ok(blampeyPrepared.includes("requiring clustering to be run multiple times"));
assert.ok(blampeyVisuals[0].caption.includes("f, ARI comparison on the synthetic dataset"));
assert.equal(blampeyVisuals[0].captionParts[0].startsWith("Fig. 3 |"), true);

const blampeyFig5Group = blampeyRepair.groups.find((group) => group.id === "vr-p0007-g0000");
assert.ok(blampeyFig5Group);
const blampeyFig5Members = blampeyFig5Group.member_block_ids.map((id) =>
	blampeyBlocks.find((block) => block.id === id),
).filter(Boolean);
assert.equal(blampeyFig5Members.length, blampeyFig5Group.member_block_ids.length);
const blampeyFig5Details = markdown.resolveVisualCaptionDetails(
	blampeyFig5Members,
	blampeyBlocks,
	blampeyRepair,
	7,
);
assert.ok(blampeyFig5Details.caption.startsWith("Fig. 5 | Novae spatial domains"));
assert.ok(blampeyFig5Details.caption.includes("MGC-positive cases (bottom)."));
assert.ok(blampeyFig5Details.caption.includes("c, Heatmap of cell-type distributions across domains."));
assert.ok(blampeyFig5Details.caption.endsWith(
	"e, FIDE score for CONCH, Novae, and Novae + CONCH on the human lung slide.",
));
const blampeyFig5Prepared = markdown.prepareReaderMarkdown(
	blampeyArticle,
	[{
		id: blampeyFig5Group.id,
		pageIdx: 7,
		label: "Fig. 5",
		...blampeyFig5Details,
		memberBlockIds: [...blampeyFig5Group.member_block_ids],
		memberAssetPaths: [...blampeyFig5Group.member_asset_paths],
		memberMarkdownImageIds: [...blampeyFig5Group.member_markdown_image_ids],
		anchorAssetPath: blampeyFig5Group.replacement.asset_path,
		display: { mode: "asset", assetPath: blampeyFig5Group.replacement.asset_path },
		repairDecision: blampeyFig5Group.decision,
		confidence: blampeyFig5Group.confidence,
	}],
	blampeyIndex,
);
assert.ok(!blampeyFig5Prepared.includes("MGC-positive cases (bottom). Box plots indicate mean"));
assert.ok(blampeyFig5Prepared.includes("the fused Novae\u2009+\u2009CONCH model achieves"));
} else {
	console.log("Skipping optional private MinerU package regression fixtures.");
}
const duplicateFormalAnchor = {
	...safeContinuation,
	text: {
		...safeContinuation.text,
		text: "Fig. 2 | A duplicate formal caption.",
		figure_keys: ["figure:2"],
		leading_figure_key: "figure:2",
	},
};
assert.equal(markdown.captionLinkMatchesBlocks(
	{ ...crossPageLink, caption_block_ids: [continuationAnchor.id] },
	crossPageIndex.pages[0].blocks[0],
	[continuationAnchor, duplicateFormalAnchor],
), false);

const fig5FormalCaption = "Fig. 5 | Metabolite discovery in mouse tissues. a, First verified panel and the experimental";
const fig5CaptionContinuation = "spectrum from mouse urine. d-g, Additional verified metabolite panels and controls.";
const fig5Markdown = [
	"c",
	"This standalone repeated letter is ordinary body context and must remain.",
	"",
	"c  ",
	"![](images/fig5-c.jpg)",
	"f  ",
	"![](images/fig5-f.jpg)",
	"![](images/fig5-caption.jpg)  ",
	fig5FormalCaption,
	"g  ",
	"![](images/fig5-g.jpg)",
	"![](images/fig5-tail.jpg)  ",
	fig5CaptionContinuation,
	"Body after the figure stays.",
].join("\n");
const fig5Index = normalization.buildRuntimeViewerIndex(
	[
		{
			type: "chart",
			page_idx: 7,
			bbox: [50, 50, 250, 250],
			img_path: "images/fig5-c.jpg",
			chart_caption: ["c"],
		},
		{
			type: "chart",
			page_idx: 7,
			bbox: [50, 260, 250, 460],
			img_path: "images/fig5-f.jpg",
			chart_caption: ["f"],
		},
		{
			type: "chart",
			page_idx: 7,
			bbox: [260, 260, 500, 460],
			img_path: "images/fig5-caption.jpg",
			chart_caption: [fig5FormalCaption],
		},
		{
			type: "chart",
			page_idx: 7,
			bbox: [510, 260, 700, 460],
			img_path: "images/fig5-g.jpg",
			chart_caption: ["g"],
		},
		{
			type: "chart",
			page_idx: 7,
			bbox: [710, 260, 950, 460],
			img_path: "images/fig5-tail.jpg",
			chart_caption: [fig5CaptionContinuation],
		},
	],
	fig5Markdown,
);
const fig5Blocks = fig5Index.pages[0].blocks;
assert.deepEqual(
	fig5Blocks.map((block) => block.caption.parts.map((part) => part.kind)),
	[
		["panel-label"],
		["panel-label"],
		["formal-caption"],
		["panel-label"],
		["caption-continuation"],
	],
);
const fig5CaptionDetails = markdown.resolveVisualCaptionDetails(
	fig5Blocks,
	fig5Blocks,
	null,
	7,
);
assert.equal(
	fig5CaptionDetails.caption,
	`${fig5FormalCaption} ${fig5CaptionContinuation}`,
);
assert.deepEqual(
	fig5CaptionDetails.captionParts,
	[],
);
assert.deepEqual(
	fig5CaptionDetails.samePageCaptionProjections,
	[
		{ markdownImageId: "md-img-0000", text: "c" },
		{ markdownImageId: "md-img-0001", text: "f" },
		{ markdownImageId: "md-img-0002", text: fig5FormalCaption },
		{ markdownImageId: "md-img-0003", text: "g" },
		{ markdownImageId: "md-img-0004", text: fig5CaptionContinuation },
	],
);
assert.deepEqual(
	fig5CaptionDetails.panelLabelProjections,
	[
		{ markdownImageId: "md-img-0000", label: "c" },
		{ markdownImageId: "md-img-0001", label: "f" },
		{ markdownImageId: "md-img-0003", label: "g" },
	],
);
const fig5Prepared = markdown.prepareReaderMarkdown(
	fig5Markdown,
	[{
		id: "fig5-group",
		pageIdx: 7,
		label: "Fig. 5",
		...fig5CaptionDetails,
		memberBlockIds: fig5Blocks.map((block) => block.id),
		memberAssetPaths: fig5Blocks.map((block) => block.asset_path),
		memberMarkdownImageIds: fig5Blocks.flatMap((block) => block.markdown_image_ids),
		anchorAssetPath: "images/fig5-c.jpg",
		display: { mode: "pdf-crop", bbox: [50, 50, 950, 460], padding: 6 },
		repairDecision: "auto",
		confidence: 0.95,
	}],
);
assert.equal((fig5Prepared.match(/data-visual-id="fig5-group"/g) || []).length, 1);
assert.deepEqual(
	fig5Prepared
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => ["c", "f", "g"].includes(line)),
	["c"],
);
assert.ok(fig5Prepared.includes("ordinary body context and must remain"));
assert.ok(fig5Prepared.includes("Body after the figure stays."));
assert.ok(!fig5Prepared.includes(fig5FormalCaption));
assert.ok(!fig5Prepared.includes(fig5CaptionContinuation));

const fig1Application1 = "Application 1: Anticipation and targeted discovery of undiscovered metabolites";
const fig1Application2 = "Application 2: Structure annotation of unknown metabolites via mass spectrometry-based metabolomic";
const fig1FormalCaption = "Fig. 1 | Learning the language of metabolism. a, Schematic overview of DeepMet. RT, retention time. b, UMAP visualization of the chemical space occupied by known metabolites and generated molecules. Known metabolites are coloured by their assigned superclasses in the ClassyFire chemical ontology.";
const fig1CaptionContinuation = "c, Receiver operating characteristic (ROC) curve of a random forest classifier trained to distinguish between known metabolites and generated molecules in cross-validation. d, Proportion of enzymatic biotransformations of known metabolites recapitulated by DeepMet, shown as a function of the number of rule-based transformations applied sequentially to the original metabolite.";
const fig1Markdown = [
	"Body citation (Fig. 1a) must remain visible.",
	"",
	"d  ",
	`${fig1Application1}  `,
	"![](images/fig1-application-1.jpg)",
	"",
	`${fig1Application2}  `,
	"![](images/fig1-application-2.jpg)",
	"",
	"![](images/fig1-b.jpg)",
	"",
	"![](images/fig1-c.jpg)",
	"",
	"![](images/fig1-caption.jpg)  ",
	`${fig1FormalCaption}  `,
	fig1CaptionContinuation,
	"",
	"Body after the reconstructed figure stays.",
	"",
	fig1Application1,
].join("\n");
const fig1Index = normalization.buildRuntimeViewerIndex(
	[
		{
			type: "image",
			page_idx: 1,
			bbox: [60, 60, 894, 294],
			img_path: "images/fig1-application-1.jpg",
			image_caption: ["d", fig1Application1],
		},
		{
			type: "image",
			page_idx: 1,
			bbox: [65, 327, 942, 484],
			img_path: "images/fig1-application-2.jpg",
			image_caption: [fig1Application2],
		},
		{
			type: "image",
			page_idx: 1,
			bbox: [58, 489, 576, 634],
			img_path: "images/fig1-b.jpg",
		},
		{
			type: "chart",
			page_idx: 1,
			bbox: [581, 491, 793, 651],
			img_path: "images/fig1-c.jpg",
		},
		{
			type: "chart",
			page_idx: 1,
			bbox: [796, 494, 944, 651],
			img_path: "images/fig1-caption.jpg",
			chart_caption: [fig1FormalCaption, fig1CaptionContinuation],
		},
	],
	fig1Markdown,
);
const fig1Blocks = fig1Index.pages[0].blocks;
const fig1CaptionDetails = markdown.resolveVisualCaptionDetails(
	fig1Blocks,
	fig1Blocks,
	null,
	1,
);
assert.equal(fig1CaptionDetails.caption, `${fig1FormalCaption} ${fig1CaptionContinuation}`);
assert.deepEqual(fig1CaptionDetails.samePageCaptionProjections, [
	{ markdownImageId: "md-img-0000", text: "d" },
	{ markdownImageId: "md-img-0000", text: fig1Application1 },
	{ markdownImageId: "md-img-0001", text: fig1Application2 },
	{ markdownImageId: "md-img-0004", text: fig1FormalCaption },
	{ markdownImageId: "md-img-0004", text: fig1CaptionContinuation },
]);
const fig1Prepared = markdown.prepareReaderMarkdown(
	fig1Markdown,
	[{
		id: "fig1-group",
		pageIdx: 1,
		label: "Fig. 1",
		...fig1CaptionDetails,
		memberBlockIds: fig1Blocks.map((block) => block.id),
		memberAssetPaths: fig1Blocks.map((block) => block.asset_path),
		memberMarkdownImageIds: fig1Blocks.flatMap((block) => block.markdown_image_ids),
		anchorAssetPath: "images/fig1-application-1.jpg",
		display: { mode: "pdf-crop", bbox: [58, 60, 944, 651], padding: 6 },
		repairDecision: "auto",
		confidence: 0.99,
	}],
);
assert.equal((fig1Prepared.match(/data-visual-id="fig1-group"/g) || []).length, 1);
assert.ok(fig1Prepared.includes("Body citation (Fig. 1a) must remain visible."));
assert.ok(fig1Prepared.includes("Body after the reconstructed figure stays."));
assert.equal(fig1Prepared.split(fig1Application1).length - 1, 1);
assert.ok(!fig1Prepared.includes(fig1Application2));
assert.ok(!fig1Prepared.includes(fig1FormalCaption));
assert.ok(!fig1Prepared.includes(fig1CaptionContinuation));
assert.equal(
	fig1Prepared.split(/\r?\n/).map((line) => line.trim()).filter((line) => line === "d").length,
	0,
);

const interruptedCaptionRun = markdown.prepareReaderMarkdown(
	["d", "Intervening body boundary.", fig1Application1, "![](images/interrupted.jpg)"].join("\n"),
	[{
		id: "interrupted-caption-run",
		pageIdx: 1,
		label: "Fig. 1",
		caption: fig1FormalCaption,
		captionParts: [],
		captionSourceBlockIds: [],
		pageRange: [1, 1],
		memberBlockIds: ["interrupted"],
		memberAssetPaths: ["images/interrupted.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
		samePageCaptionProjections: [
			{ markdownImageId: "md-img-0000", text: "d" },
			{ markdownImageId: "md-img-0000", text: fig1Application1 },
		],
		anchorAssetPath: "images/interrupted.jpg",
		display: { mode: "asset", assetPath: "images/interrupted.jpg" },
		repairDecision: "keep-original",
		confidence: 1,
	}],
);
assert.ok(interruptedCaptionRun.startsWith("d\n"));
assert.ok(interruptedCaptionRun.includes(fig1Application1));
assert.ok(interruptedCaptionRun.includes("Intervening body boundary."));

const splitPlaceholderText = "Extended Data Fig. 3 | See next page for caption.";
const splitCaptionRun = markdown.prepareReaderMarkdown(
	["q", "r", "![](images/split-run.jpg)", splitPlaceholderText, "Body stays."].join("\n"),
	[{
		id: "split-caption-run",
		pageIdx: 23,
		label: "Extended Data Fig. 3",
		caption: splitPlaceholderText,
		captionParts: [],
		captionSourceBlockIds: [],
		pageRange: [23, 24],
		memberBlockIds: ["split"],
		memberAssetPaths: ["images/split-run.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
		samePageCaptionProjections: [
			{ markdownImageId: "md-img-0000", text: "q" },
			{ markdownImageId: "md-img-0000", text: "r" },
			{ markdownImageId: "md-img-0000", text: splitPlaceholderText },
		],
		anchorAssetPath: "images/split-run.jpg",
		display: { mode: "asset", assetPath: "images/split-run.jpg" },
		repairDecision: "keep-original",
		confidence: 1,
	}],
);
assert.ok(!splitCaptionRun.split(/\r?\n/).some((line) => ["q", "r", splitPlaceholderText].includes(line.trim())));
assert.ok(splitCaptionRun.includes("Body stays."));

const ambiguousTwoSidedRun = markdown.prepareReaderMarkdown(
	["c", "![](images/two-sided.jpg)", "c", "Body stays."].join("\n"),
	[{
		id: "two-sided-caption-run",
		pageIdx: 2,
		label: "图像",
		caption: "c",
		captionParts: [],
		captionSourceBlockIds: [],
		pageRange: [2, 2],
		memberBlockIds: ["two-sided"],
		memberAssetPaths: ["images/two-sided.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
		samePageCaptionProjections: [{ markdownImageId: "md-img-0000", text: "c" }],
		anchorAssetPath: "images/two-sided.jpg",
		display: { mode: "asset", assetPath: "images/two-sided.jpg" },
		repairDecision: "keep-original",
		confidence: 1,
	}],
);
assert.equal(ambiguousTwoSidedRun.split(/\r?\n/).filter((line) => line.trim() === "c").length, 2);

const secondSafeContinuation = {
	...fig5Blocks[4],
	id: "p0007-s999999",
	source_index: 999999,
	page_order: 5,
	caption: {
		...fig5Blocks[4].caption,
		text: "another plausible continuation that creates ambiguity and must not be joined.",
		parts: [{
			text: "another plausible continuation that creates ambiguity and must not be joined.",
			kind: "caption-continuation",
		}],
	},
};
const ambiguousSamePageCaption = markdown.resolveVisualCaptionDetails(
	[...fig5Blocks, secondSafeContinuation],
	[...fig5Blocks, secondSafeContinuation],
	null,
	7,
);
assert.equal(ambiguousSamePageCaption.caption, fig5FormalCaption);
assert.deepEqual(ambiguousSamePageCaption.captionParts, []);

const standaloneExtendedCaption = "Extended Data Figure 1 ｜\u202fA language model of the human metabolome. a, Schematic overview of the classifier.";
const standaloneExtendedBodyReference = "Extended Data Fig. 1 shows the model architecture and must remain visible.";
const standaloneExtendedMarkdown = [
	"![](images/ext1-right-top.jpg)",
	"![](images/ext1-left-top.jpg)",
	"![](images/ext1-left-bottom.jpg)",
	"",
	standaloneExtendedCaption,
	"",
	"![](images/ext1-right-bottom.jpg)",
	standaloneExtendedBodyReference,
].join("\n") + "\n";
const standaloneExtendedIndex = normalization.buildRuntimeViewerIndex(
	[
		{
			type: "image",
			page_idx: 21,
			bbox: [544, 62, 927, 313],
			img_path: "images/ext1-right-top.jpg",
		},
		{
			type: "image",
			page_idx: 21,
			bbox: [80, 59, 515, 224],
			img_path: "images/ext1-left-top.jpg",
		},
		{
			type: "image",
			page_idx: 21,
			bbox: [78, 329, 515, 667],
			img_path: "images/ext1-left-bottom.jpg",
		},
		{
			type: "text",
			page_idx: 21,
			bbox: [60, 681, 495, 835],
			text: standaloneExtendedCaption,
		},
		{
			type: "chart",
			page_idx: 21,
			bbox: [554, 494, 934, 665],
			img_path: "images/ext1-right-bottom.jpg",
		},
		{
			type: "text",
			page_idx: 21,
			bbox: [60, 850, 940, 890],
			text: standaloneExtendedBodyReference,
		},
	],
	standaloneExtendedMarkdown,
);
const standaloneExtendedBlocks = standaloneExtendedIndex.pages[0].blocks;
const standaloneExtendedGroups = [
	{
		id: "vr-p0021-g0000",
		page_idx: 21,
		member_block_ids: [standaloneExtendedBlocks[1].id, standaloneExtendedBlocks[2].id],
		member_markdown_image_ids: ["md-img-0001", "md-img-0002"],
		decision: "auto",
		confidence: 0.95,
		replacement: { mode: "pdf_crop", bbox_norm: [78, 59, 515, 667], padding_norm: 6 },
		signals: { panel_label_count: 2 },
	},
	{
		id: "vr-p0021-g0001",
		page_idx: 21,
		member_block_ids: [standaloneExtendedBlocks[0].id, standaloneExtendedBlocks[4].id],
		member_markdown_image_ids: ["md-img-0000", "md-img-0003"],
		decision: "auto",
		confidence: 0.85,
		replacement: { mode: "pdf_crop", bbox_norm: [544, 62, 934, 665], padding_norm: 6 },
		signals: { panel_label_count: 2 },
	},
];
const mergedStandaloneExtendedGroups = markdown.mergeStandaloneCaptionRepairGroups(
	standaloneExtendedGroups,
	standaloneExtendedBlocks,
);
assert.equal(mergedStandaloneExtendedGroups.length, 1);
assert.deepEqual(mergedStandaloneExtendedGroups[0].member_block_ids, [
	standaloneExtendedBlocks[0].id,
	standaloneExtendedBlocks[1].id,
	standaloneExtendedBlocks[2].id,
	standaloneExtendedBlocks[4].id,
]);
assert.deepEqual(mergedStandaloneExtendedGroups[0].member_markdown_image_ids, [
	"md-img-0000",
	"md-img-0001",
	"md-img-0002",
	"md-img-0003",
]);
assert.deepEqual(mergedStandaloneExtendedGroups[0].replacement.bbox_norm, [78, 59, 934, 667]);

const boundedCaptionText = "Figure 7 A complete standalone caption shared by both nearby fragments.";
const boundedCaptionIndex = normalization.buildRuntimeViewerIndex(
	[
		{
			type: "image",
			page_idx: 40,
			bbox: [60, 100, 460, 390],
			img_path: "images/bounded-left.jpg",
		},
		{
			type: "image",
			page_idx: 40,
			bbox: [510, 100, 930, 390],
			img_path: "images/bounded-right.jpg",
		},
		{
			type: "text",
			page_idx: 40,
			bbox: [60, 420, 930, 510],
			text: boundedCaptionText,
		},
	],
	[
		"![](images/bounded-left.jpg)",
		"![](images/bounded-right.jpg)",
		boundedCaptionText,
	].join("\n") + "\n",
);
const boundedCaptionBlocks = boundedCaptionIndex.pages[0].blocks;
const boundedCaptionGroups = markdown.mergeStandaloneCaptionRepairGroups([
	{
		id: "bounded-left",
		page_idx: 40,
		member_block_ids: [boundedCaptionBlocks[0].id],
		member_markdown_image_ids: ["md-img-0000"],
		decision: "auto",
		confidence: 0.9,
		replacement: { mode: "pdf_crop", bbox_norm: [60, 100, 460, 390], padding_norm: 6 },
		signals: { panel_label_count: 0 },
	},
	{
		id: "bounded-right",
		page_idx: 40,
		member_block_ids: [boundedCaptionBlocks[1].id],
		member_markdown_image_ids: ["md-img-0001"],
		decision: "auto",
		confidence: 0.9,
		replacement: { mode: "pdf_crop", bbox_norm: [510, 100, 930, 390], padding_norm: 6 },
		signals: { panel_label_count: 0 },
	},
], boundedCaptionBlocks);
assert.equal(boundedCaptionGroups.length, 1);
assert.deepEqual(boundedCaptionGroups[0].member_block_ids, [
	boundedCaptionBlocks[0].id,
	boundedCaptionBlocks[1].id,
]);
assert.ok(boundedCaptionGroups[0].reason_codes.includes("reading_order_caption_spatial_bridge"));

const referenceOnlyIndex = normalization.buildRuntimeViewerIndex(
	[
		{
			type: "image",
			page_idx: 41,
			bbox: [60, 100, 460, 390],
			img_path: "images/reference-left.jpg",
		},
		{
			type: "image",
			page_idx: 41,
			bbox: [510, 100, 930, 390],
			img_path: "images/reference-right.jpg",
		},
		{
			type: "text",
			page_idx: 41,
			bbox: [60, 420, 930, 510],
			text: "Figure 7 shows the two independent results in ordinary prose.",
		},
	],
	"![](images/reference-left.jpg)\n![](images/reference-right.jpg)\n",
);
const referenceOnlyBlocks = referenceOnlyIndex.pages[0].blocks;
const referenceOnlyGroups = markdown.mergeStandaloneCaptionRepairGroups([
	{
		...boundedCaptionGroups[0],
		id: "reference-left",
		page_idx: 41,
		member_block_ids: [referenceOnlyBlocks[0].id],
		member_markdown_image_ids: ["md-img-0000"],
		replacement: { mode: "pdf_crop", bbox_norm: [60, 100, 460, 390], padding_norm: 6 },
	},
	{
		...boundedCaptionGroups[0],
		id: "reference-right",
		page_idx: 41,
		member_block_ids: [referenceOnlyBlocks[1].id],
		member_markdown_image_ids: ["md-img-0001"],
		replacement: { mode: "pdf_crop", bbox_norm: [510, 100, 930, 390], padding_norm: 6 },
	},
], referenceOnlyBlocks);
assert.equal(referenceOnlyGroups.length, 2);

const nestedDuplicatePlaceholder = "Extended Data Fig. 4 | See next page for caption.";
const nestedDuplicateCaption = "Extended Data Fig. 4 | A complete caption transferred from the contained panel strip.";
const nestedDuplicateMarkdown = [
	"![](images/whole-left.jpg)",
	"![](images/whole-right.jpg)",
	"![](images/repeated-pqr.jpg)",
	nestedDuplicateCaption,
].join("\n") + "\n";
const nestedDuplicateIndex = normalization.buildRuntimeViewerIndex(
	[
		{
			type: "image",
			page_idx: 25,
			bbox: [50, 50, 680, 900],
			img_path: "images/whole-left.jpg",
			image_caption: ["a"],
		},
		{
			type: "image",
			page_idx: 25,
			bbox: [680, 50, 950, 540],
			img_path: "images/whole-right.jpg",
			image_caption: ["o"],
		},
		{
			type: "image",
			page_idx: 25,
			bbox: [700, 550, 920, 860],
			img_path: "images/repeated-pqr.jpg",
			image_caption: [nestedDuplicatePlaceholder, "p", "q", "r"],
		},
		{
			type: "text",
			page_idx: 26,
			bbox: [50, 50, 950, 170],
			text: nestedDuplicateCaption,
		},
	],
	nestedDuplicateMarkdown,
);
const nestedDuplicateBlocks = nestedDuplicateIndex.pages.flatMap((page) => page.blocks);
const nestedSourceBlocks = nestedDuplicateIndex.pages[0].blocks;
const nestedDuplicateGroups = [{
	id: "whole-figure",
	page_idx: 25,
	member_block_ids: [nestedSourceBlocks[0].id, nestedSourceBlocks[1].id],
	member_markdown_image_ids: ["md-img-0000", "md-img-0001"],
	decision: "auto",
	confidence: 0.96,
	replacement: { mode: "pdf_crop", bbox_norm: [50, 50, 950, 900], padding_norm: 6 },
	caption_anchor_block_ids: [],
	signals: { member_count: 2, panel_label_count: 2 },
	reason_codes: ["same_page_connected_visuals"],
}, {
	id: "repeated-panel-strip",
	page_idx: 25,
	member_block_ids: [nestedSourceBlocks[2].id],
	member_markdown_image_ids: ["md-img-0002"],
	decision: "auto",
	confidence: 0.99,
	replacement: { mode: "pdf_crop", bbox_norm: [700, 550, 920, 860], padding_norm: 6 },
	caption_anchor_block_ids: [nestedSourceBlocks[2].id],
	signals: { member_count: 1, panel_label_count: 3 },
	reason_codes: ["long_caption_attached"],
}];
const mergedNestedDuplicateGroups = markdown.mergeNestedVisualRepairGroups(
	nestedDuplicateGroups,
	nestedDuplicateBlocks,
);
assert.equal(mergedNestedDuplicateGroups.length, 1);
assert.equal(mergedNestedDuplicateGroups[0].id, "whole-figure");
assert.deepEqual(mergedNestedDuplicateGroups[0].replacement.bbox_norm, [50, 50, 950, 900]);
assert.deepEqual(mergedNestedDuplicateGroups[0].member_block_ids, nestedSourceBlocks.map((block) => block.id));
assert.deepEqual(mergedNestedDuplicateGroups[0].member_markdown_image_ids, [
	"md-img-0000",
	"md-img-0001",
	"md-img-0002",
]);
assert.deepEqual(mergedNestedDuplicateGroups[0].member_asset_paths, [
	"images/repeated-pqr.jpg",
	"images/whole-left.jpg",
	"images/whole-right.jpg",
]);
const nestedContractArticleHash = "c".repeat(64);
const nestedContractMineruHash = "d".repeat(64);
const nestedContractIndex = structuredClone(nestedDuplicateIndex);
nestedContractIndex.inputs = {
	article: { path: "article.md", sha256: nestedContractArticleHash },
	mineru_result: { path: "mineru-result.json", sha256: nestedContractMineruHash },
};
nestedContractIndex.pdf_source = {
	packaged_path: "_extraction/source.pdf",
	manifest_source_fallback: true,
};
const nestedContractRepair = {
	schema_version: 1,
	algorithm_version: "visual-repair-v1.11",
	viewer_index: "runtime",
	status: "complete",
	inputs: nestedContractIndex.inputs,
	groups: mergedNestedDuplicateGroups,
	caption_links: [],
	issues: [],
};
assert.deepEqual(visualRepair.validateVisualContracts({
	viewerIndex: nestedContractIndex,
	visualRepair: nestedContractRepair,
	sourceIndex: nestedContractIndex,
	articleHash: nestedContractArticleHash,
	mineruHash: nestedContractMineruHash,
}), []);
const staleNestedAssetContract = structuredClone(nestedContractRepair);
staleNestedAssetContract.groups[0].member_asset_paths.pop();
assert.ok(visualRepair.validateVisualContracts({
	viewerIndex: nestedContractIndex,
	visualRepair: staleNestedAssetContract,
	sourceIndex: nestedContractIndex,
	articleHash: nestedContractArticleHash,
	mineruHash: nestedContractMineruHash,
}).some((error) => error.includes("资产清单不一致")));
assert.deepEqual(mergedNestedDuplicateGroups[0].caption_anchor_block_ids, [nestedSourceBlocks[2].id]);
assert.ok(mergedNestedDuplicateGroups[0].reason_codes.includes("nested_visual_overlap_deduplicated"));
const nestedDuplicateDetails = markdown.resolveVisualCaptionDetails(
	nestedSourceBlocks,
	nestedDuplicateBlocks,
	null,
	25,
);
assert.equal(nestedDuplicateDetails.caption, nestedDuplicateCaption);
assert.equal(nestedDuplicateDetails.captionPageIdx, 26);
const nestedDuplicatePrepared = markdown.prepareReaderMarkdown(
	nestedDuplicateMarkdown,
	[{
		id: "whole-figure",
		pageIdx: 25,
		label: "Extended Data Fig. 4",
		...nestedDuplicateDetails,
		memberBlockIds: mergedNestedDuplicateGroups[0].member_block_ids,
		memberAssetPaths: ["images/whole-left.jpg", "images/whole-right.jpg", "images/repeated-pqr.jpg"],
		memberMarkdownImageIds: mergedNestedDuplicateGroups[0].member_markdown_image_ids,
		anchorAssetPath: "images/whole-left.jpg",
		display: { mode: "pdf-crop", bbox: [50, 50, 950, 900], padding: 6 },
		repairDecision: "auto",
		confidence: 0.96,
	}],
);
assert.equal((nestedDuplicatePrepared.match(/data-visual-id="whole-figure"/g) || []).length, 1);
assert.ok(!nestedDuplicatePrepared.includes("repeated-pqr.jpg"));

const nestedNoCaptionBlocks = nestedDuplicateBlocks.map((block) => (
	block.id === nestedSourceBlocks[2].id
		? {
			...block,
			caption: {
				...block.caption,
				text: "p q r",
				parts: [{ text: "p", kind: "panel-label" }],
				figure_keys: [],
				formal_figure_caption_keys: [],
				leading_figure_key: null,
				leading_formal_figure_caption_key: null,
				next_page_marker: false,
				next_page_figure_keys: [],
			},
		}
		: block
));
assert.equal(
	markdown.mergeNestedVisualRepairGroups(nestedDuplicateGroups, nestedNoCaptionBlocks).length,
	2,
);
const nestedPartialOverlapGroups = nestedDuplicateGroups.map((group) => (
	group.id === "repeated-panel-strip"
		? { ...group, replacement: { ...group.replacement, bbox_norm: [850, 550, 990, 860] } }
		: group
));
assert.equal(
	markdown.mergeNestedVisualRepairGroups(nestedPartialOverlapGroups, nestedDuplicateBlocks).length,
	2,
);
const standaloneExtendedMembers = mergedStandaloneExtendedGroups[0].member_block_ids
	.map((id) => standaloneExtendedBlocks.find((block) => block.id === id));
const standaloneExtendedDetails = markdown.resolveVisualCaptionDetails(
	standaloneExtendedMembers,
	standaloneExtendedBlocks,
	null,
	21,
);
assert.equal(standaloneExtendedDetails.caption, standaloneExtendedCaption);
assert.deepEqual(standaloneExtendedDetails.samePageCaptionProjections, [{
	markdownImageId: "md-img-0002",
	text: standaloneExtendedCaption,
}]);
const standaloneExtendedRight = markdown.resolveVisualCaptionDetails(
	[standaloneExtendedBlocks[0], standaloneExtendedBlocks[4]],
	standaloneExtendedBlocks,
	null,
	21,
);
assert.equal(standaloneExtendedRight.caption, "");
assert.deepEqual(standaloneExtendedRight.samePageCaptionProjections, []);
const standaloneExtendedPrepared = markdown.prepareReaderMarkdown(
	standaloneExtendedMarkdown,
	[{
		id: "extended-data-figure-1",
		pageIdx: 21,
		label: "Extended Data Figure 1",
		...standaloneExtendedDetails,
		memberBlockIds: mergedStandaloneExtendedGroups[0].member_block_ids,
		memberAssetPaths: [
			"images/ext1-right-top.jpg",
			"images/ext1-left-top.jpg",
			"images/ext1-left-bottom.jpg",
			"images/ext1-right-bottom.jpg",
		],
		memberMarkdownImageIds: mergedStandaloneExtendedGroups[0].member_markdown_image_ids,
		anchorAssetPath: "images/ext1-right-top.jpg",
		display: { mode: "pdf-crop", bbox: [78, 59, 934, 667], padding: 6 },
		repairDecision: "auto",
		confidence: 0.85,
	}],
);
assert.equal((standaloneExtendedPrepared.match(/data-visual-id="extended-data-figure-1"/g) || []).length, 1);
assert.ok(!standaloneExtendedPrepared.includes(standaloneExtendedCaption));
assert.ok(standaloneExtendedPrepared.includes(standaloneExtendedBodyReference));

const splitStandaloneAnchor = "Extended Data Fig. 2 | DeepMet anticipates metabolites absent from the training set. e, Heatmap showing the proportion of";
const splitStandaloneContinuation = "generated metabolites recapitulating one- to four-step enzymatic transformations of human metabolites predicted by BioTransformer.";
const splitStandaloneMarkdown = [
	"![](images/ext2.jpg)",
	"",
	splitStandaloneAnchor,
	"",
	splitStandaloneContinuation,
	"Body reference to Extended Data Fig. 2 remains visible.",
].join("\n") + "\n";
const splitStandaloneIndex = normalization.buildRuntimeViewerIndex(
	[
		{ type: "image", page_idx: 22, bbox: [82, 65, 936, 725], img_path: "images/ext2.jpg" },
		{ type: "text", page_idx: 22, bbox: [60, 735, 497, 878], text: splitStandaloneAnchor },
		{ type: "text", page_idx: 22, bbox: [507, 735, 939, 865], text: splitStandaloneContinuation },
	],
	splitStandaloneMarkdown,
);
const splitStandaloneBlocks = splitStandaloneIndex.pages[0].blocks;
const splitStandaloneDetails = markdown.resolveVisualCaptionDetails(
	[splitStandaloneBlocks[0]],
	splitStandaloneBlocks,
	null,
	22,
);
assert.equal(
	splitStandaloneDetails.caption,
	`${splitStandaloneAnchor} ${splitStandaloneContinuation}`,
);
assert.deepEqual(splitStandaloneDetails.samePageCaptionProjections, [
	{ markdownImageId: "md-img-0000", text: splitStandaloneAnchor },
	{ markdownImageId: "md-img-0000", text: splitStandaloneContinuation },
]);
const splitStandalonePrepared = markdown.prepareReaderMarkdown(
	splitStandaloneMarkdown,
	[{
		id: "extended-data-figure-2",
		pageIdx: 22,
		label: "Extended Data Fig. 2",
		...splitStandaloneDetails,
		memberBlockIds: [splitStandaloneBlocks[0].id],
		memberAssetPaths: ["images/ext2.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
		anchorAssetPath: "images/ext2.jpg",
		display: { mode: "asset", assetPath: "images/ext2.jpg" },
		repairDecision: "keep-original",
		confidence: 1,
	}],
);
assert.ok(!splitStandalonePrepared.includes(splitStandaloneAnchor));
assert.ok(!splitStandalonePrepared.includes(splitStandaloneContinuation));
assert.ok(splitStandalonePrepared.includes("Body reference to Extended Data Fig. 2 remains visible."));

const terminalSplitAnchor = "Extended Data Fig. 4 | The first caption sentence is complete.";
const terminalSplitPanel = "a, Additional caption content continues in the aligned second column and ends here.";
const terminalSplitMarkdown = `![](images/ext4-terminal.jpg)\n\n${terminalSplitAnchor}\n\n${terminalSplitPanel}\n`;
const terminalSplitIndex = normalization.buildRuntimeViewerIndex(
	[
		{ type: "image", page_idx: 24, bbox: [70, 60, 935, 700], img_path: "images/ext4-terminal.jpg" },
		{ type: "text", page_idx: 24, bbox: [60, 715, 497, 850], text: terminalSplitAnchor },
		{ type: "text", page_idx: 24, bbox: [507, 715, 940, 845], text: terminalSplitPanel },
	],
	terminalSplitMarkdown,
);
const terminalSplitBlocks = terminalSplitIndex.pages[0].blocks;
const terminalSplitDetails = markdown.resolveVisualCaptionDetails(
	[terminalSplitBlocks[0]],
	terminalSplitBlocks,
	null,
	24,
);
assert.equal(terminalSplitDetails.caption, `${terminalSplitAnchor} ${terminalSplitPanel}`);
assert.deepEqual(terminalSplitDetails.samePageCaptionProjections, [
	{ markdownImageId: "md-img-0000", text: terminalSplitAnchor },
	{ markdownImageId: "md-img-0000", text: terminalSplitPanel },
]);

const extendedTableCaption = "Extended Data Fig. 10 | Origins of selected metabolites. Far left, inferred origins of each metabolite.";
const extendedTableHtml = '<table><tr><td>Category</td><td><img src="images/ext10-cell-a.jpg"/></td></tr><tr><td>Host</td><td><img src="images/ext10-cell-b.jpg"/></td></tr></table>';
const extendedTableMarkdown = [
	extendedTableHtml,
	"",
	extendedTableCaption,
	"Body reference to Extended Data Fig. 10 remains visible.",
	"![](images/following.jpg)",
].join("\n") + "\n";
const extendedTableIndex = normalization.buildRuntimeViewerIndex(
	[
		{
			type: "table",
			page_idx: 35,
			bbox: [63, 55, 495, 349],
			img_path: "images/ext10-table.jpg",
			table_body: extendedTableHtml,
		},
		{ type: "text", page_idx: 35, bbox: [60, 354, 497, 472], text: extendedTableCaption },
		{ type: "image", page_idx: 36, bbox: [60, 60, 500, 400], img_path: "images/following.jpg" },
	],
	extendedTableMarkdown,
);
const extendedTableBlocks = extendedTableIndex.pages.flatMap((page) => page.blocks);
assert.deepEqual(extendedTableBlocks[0].markdown_table_range, {
	offset_unit: "utf16-code-unit",
	start: 0,
	end: extendedTableHtml.length,
});
assert.deepEqual(extendedTableBlocks[0].markdown_image_ids, []);
assert.deepEqual(extendedTableBlocks[1].markdown_text_range, {
	offset_unit: "utf16-code-unit",
	start: extendedTableHtml.length + 2,
	end: extendedTableHtml.length + 2 + extendedTableCaption.length + 1,
});
const extendedTableDetails = markdown.resolveVisualCaptionDetails(
	[extendedTableBlocks[0]],
	extendedTableBlocks,
	null,
	35,
);
assert.equal(extendedTableDetails.caption, extendedTableCaption);
assert.deepEqual(extendedTableDetails.samePageCaptionProjections, []);
assert.deepEqual(extendedTableDetails.atomicBlockProjection, {
	tableBlockId: extendedTableBlocks[0].id,
	tableRange: extendedTableBlocks[0].markdown_table_range,
	captionRange: extendedTableBlocks[1].markdown_text_range,
	captionText: extendedTableCaption,
});
const extendedTablePrepared = markdown.prepareReaderMarkdown(
	extendedTableMarkdown,
	[
		{
			id: "extended-data-figure-10",
			pageIdx: 35,
			label: "Extended Data Fig. 10",
			...extendedTableDetails,
			memberBlockIds: [extendedTableBlocks[0].id],
			memberAssetPaths: ["images/ext10-table.jpg"],
			memberMarkdownImageIds: [],
			anchorAssetPath: "images/ext10-table.jpg",
			display: { mode: "asset", assetPath: "images/ext10-table.jpg" },
			repairDecision: "keep-original",
			confidence: 1,
		},
		{
			id: "following-visual",
			pageIdx: 36,
			label: "图像 2",
			caption: "",
			captionParts: [],
			captionSourceBlockIds: [],
			pageRange: [36, 36],
			memberBlockIds: [extendedTableBlocks[2].id],
			memberAssetPaths: ["images/not-the-token-path.jpg"],
			memberMarkdownImageIds: ["md-img-0002"],
			anchorAssetPath: "images/not-the-token-path.jpg",
			display: { mode: "asset", assetPath: "images/not-the-token-path.jpg" },
			repairDecision: "keep-original",
			confidence: 1,
		},
	],
);
assert.equal((extendedTablePrepared.match(/data-visual-id="extended-data-figure-10"/g) || []).length, 1);
assert.equal((extendedTablePrepared.match(/data-visual-id="following-visual"/g) || []).length, 1);
assert.ok(!extendedTablePrepared.includes(extendedTableHtml));
assert.ok(!extendedTablePrepared.includes(extendedTableCaption));
assert.ok(extendedTablePrepared.includes("Body reference to Extended Data Fig. 10 remains visible."));

const bodyInterruptedTableMarkdown = extendedTableMarkdown.replace(
	`\n\n${extendedTableCaption}`,
	`\n\nInserted body prose must block atomic matching.\n\n${extendedTableCaption}`,
);
const bodyInterruptedTablePrepared = markdown.prepareReaderMarkdown(
	bodyInterruptedTableMarkdown,
	[{
		id: "extended-data-figure-10",
		pageIdx: 35,
		label: "Extended Data Fig. 10",
		...extendedTableDetails,
		memberBlockIds: [extendedTableBlocks[0].id],
		memberAssetPaths: ["images/ext10-table.jpg"],
		memberMarkdownImageIds: [],
		anchorAssetPath: "images/ext10-table.jpg",
		display: { mode: "asset", assetPath: "images/ext10-table.jpg" },
		repairDecision: "keep-original",
		confidence: 1,
	}],
);
assert.ok(bodyInterruptedTablePrepared.includes(extendedTableHtml));
assert.ok(bodyInterruptedTablePrepared.includes(extendedTableCaption));

const rewrittenTableCaptionMarkdown = extendedTableMarkdown.replace("Origins of selected", "Origin of selected");
const rewrittenTableCaptionPrepared = markdown.prepareReaderMarkdown(
	rewrittenTableCaptionMarkdown,
	[{
		id: "extended-data-figure-10",
		pageIdx: 35,
		label: "Extended Data Fig. 10",
		...extendedTableDetails,
		memberBlockIds: [extendedTableBlocks[0].id],
		memberAssetPaths: ["images/ext10-table.jpg"],
		memberMarkdownImageIds: [],
		anchorAssetPath: "images/ext10-table.jpg",
		display: { mode: "asset", assetPath: "images/ext10-table.jpg" },
		repairDecision: "keep-original",
		confidence: 1,
	}],
);
assert.ok(rewrittenTableCaptionPrepared.includes(extendedTableHtml));
assert.ok(rewrittenTableCaptionPrepared.includes("Origin of selected"));

const duplicateTableIndex = normalization.buildRuntimeViewerIndex(
	[{
		type: "table",
		page_idx: 1,
		bbox: [60, 60, 500, 300],
		img_path: "images/duplicate-table.jpg",
		table_body: extendedTableHtml,
	}],
	`${extendedTableHtml}\n${extendedTableHtml}\n`,
);
assert.equal(duplicateTableIndex.pages[0].blocks[0].markdown_table_range, undefined);
const noAssetTableIndex = normalization.buildRuntimeViewerIndex(
	[{ type: "table", page_idx: 1, bbox: [60, 60, 500, 300], table_body: extendedTableHtml }],
	`${extendedTableHtml}\n`,
);
assert.equal(noAssetTableIndex.pages[0].blocks[0].markdown_table_range, undefined);
const wrappedTableIndex = normalization.buildRuntimeViewerIndex(
	[{
		type: "table",
		page_idx: 1,
		bbox: [60, 60, 500, 300],
		img_path: "images/wrapped-table.jpg",
		table_body: `prefix ${extendedTableHtml}`,
	}],
	`prefix ${extendedTableHtml}\n`,
);
assert.equal(wrappedTableIndex.pages[0].blocks[0].markdown_table_range, undefined);
const inlineTableIndex = normalization.buildRuntimeViewerIndex(
	[{
		type: "table",
		page_idx: 1,
		bbox: [60, 60, 500, 300],
		img_path: "images/inline-table.jpg",
		table_body: extendedTableHtml,
	}],
	`prefix ${extendedTableHtml} suffix\n`,
);
assert.equal(inlineTableIndex.pages[0].blocks[0].markdown_table_range, undefined);

const ambiguousTableMarkdown = [
	'<table><tr><td>Left</td></tr></table>',
	'<table><tr><td>Right</td></tr></table>',
	extendedTableCaption,
].join("\n") + "\n";
const ambiguousTableIndex = normalization.buildRuntimeViewerIndex(
	[
		{ type: "table", page_idx: 35, bbox: [50, 50, 470, 340], img_path: "images/left-table.jpg", table_body: '<table><tr><td>Left</td></tr></table>' },
		{ type: "table", page_idx: 35, bbox: [530, 50, 950, 340], img_path: "images/right-table.jpg", table_body: '<table><tr><td>Right</td></tr></table>' },
		{ type: "text", page_idx: 35, bbox: [50, 350, 950, 470], text: extendedTableCaption },
	],
	ambiguousTableMarkdown,
);
const ambiguousTableBlocks = ambiguousTableIndex.pages[0].blocks;
for (const tableBlock of ambiguousTableBlocks.slice(0, 2)) {
	const details = markdown.resolveVisualCaptionDetails([tableBlock], ambiguousTableBlocks, null, 35);
	assert.equal(details.atomicBlockProjection, undefined);
	assert.equal(details.caption, "");
}

const duplicateTableCaptionMarkdown = `${extendedTableHtml}\n\n${extendedTableCaption}\n${extendedTableCaption}\n`;
const duplicateTableCaptionIndex = normalization.buildRuntimeViewerIndex(
	[
		{ type: "table", page_idx: 35, bbox: [63, 55, 495, 349], img_path: "images/ext10-table.jpg", table_body: extendedTableHtml },
		{ type: "text", page_idx: 35, bbox: [60, 354, 497, 472], text: extendedTableCaption },
	],
	duplicateTableCaptionMarkdown,
);
const duplicateCaptionBlocks = duplicateTableCaptionIndex.pages[0].blocks;
assert.equal(duplicateCaptionBlocks[1].markdown_text_range, undefined);
const duplicateCaptionDetails = markdown.resolveVisualCaptionDetails(
	[duplicateCaptionBlocks[0]],
	duplicateCaptionBlocks,
	null,
	35,
);
assert.equal(duplicateCaptionDetails.atomicBlockProjection, undefined);

const ordinaryTableCaption = "Table 1. Participant characteristics.";
const ordinaryTableIndex = normalization.buildRuntimeViewerIndex(
	[
		{ type: "table", page_idx: 2, bbox: [60, 60, 500, 300], img_path: "images/table-1.jpg", table_body: extendedTableHtml },
		{ type: "text", page_idx: 2, bbox: [60, 310, 500, 360], text: ordinaryTableCaption },
	],
	`${extendedTableHtml}\n${ordinaryTableCaption}\n`,
);
const ordinaryTableBlocks = ordinaryTableIndex.pages[0].blocks;
assert.equal(
	markdown.resolveVisualCaptionDetails([ordinaryTableBlocks[0]], ordinaryTableBlocks, null, 2).atomicBlockProjection,
	undefined,
);

const incompleteSplitStandaloneIndex = normalization.buildRuntimeViewerIndex(
	[
		{ type: "image", page_idx: 22, bbox: [82, 65, 936, 725], img_path: "images/ext2-incomplete.jpg" },
		{ type: "text", page_idx: 22, bbox: [60, 735, 497, 878], text: splitStandaloneAnchor },
		{ type: "text", page_idx: 22, bbox: [507, 735, 939, 865], text: "Generated continuation begins like ordinary prose and must stay visible." },
	],
	`![](images/ext2-incomplete.jpg)\n\n${splitStandaloneAnchor}\n\nGenerated continuation begins like ordinary prose and must stay visible.\n`,
);
const incompleteSplitStandaloneBlocks = incompleteSplitStandaloneIndex.pages[0].blocks;
const incompleteSplitStandaloneDetails = markdown.resolveVisualCaptionDetails(
	[incompleteSplitStandaloneBlocks[0]],
	incompleteSplitStandaloneBlocks,
	null,
	22,
);
assert.equal(incompleteSplitStandaloneDetails.caption, "");
assert.deepEqual(incompleteSplitStandaloneDetails.samePageCaptionProjections, []);

const ambiguousStandaloneCaption = "Extended Data Fig. 9 | A full-width caption below two unrelated visual groups.";
const ambiguousStandaloneIndex = normalization.buildRuntimeViewerIndex(
	[
		{ type: "image", page_idx: 9, bbox: [50, 50, 470, 500], img_path: "images/ext9-left.jpg" },
		{ type: "image", page_idx: 9, bbox: [530, 50, 950, 500], img_path: "images/ext9-right.jpg" },
		{ type: "text", page_idx: 9, bbox: [50, 510, 950, 600], text: ambiguousStandaloneCaption },
	],
	`![](images/ext9-left.jpg)\n![](images/ext9-right.jpg)\n${ambiguousStandaloneCaption}\n`,
);
const ambiguousStandaloneBlocks = ambiguousStandaloneIndex.pages[0].blocks;
for (const candidate of ambiguousStandaloneBlocks.slice(0, 2)) {
	const details = markdown.resolveVisualCaptionDetails(
		[candidate],
		ambiguousStandaloneBlocks,
		null,
		9,
	);
	assert.equal(details.caption, "");
	assert.deepEqual(details.samePageCaptionProjections, []);
}
assert.deepEqual(normalization.normalizeBbox([0.1, 0.2, 0.9, 0.8]), [100, 200, 900, 800]);
assert.deepEqual(normalization.normalizeBbox([0, 0, 1, 1], false), [0, 0, 1, 1]);
assert.equal(normalization.normalizeBbox([false, 0, 1, 1]), null);
assert.deepEqual(normalization.paddedBbox([4, 5, 998, 999], 6), [0, 0, 1000, 1000]);
assert.deepEqual(normalization.bboxToPercent([100, 200, 900, 800]), {
	left: 10,
	top: 20,
	width: 80,
	height: 60,
});
assert.equal(normalization.normalizeAssetPath("../outside.jpg"), "");
assert.equal(normalization.normalizeAssetPath(".."), "");
assert.equal(normalization.normalizeAssetPath("images/../outside.jpg"), "");
assert.equal(normalization.normalizeAssetPath("https://example.test/a.jpg"), "");
assert.deepEqual(
	normalization.extractMarkdownImages("![](images/a.jpg)\n<img src=\"images/b.jpg\">\n").map((image) => [image.id, image.asset_path]),
	[["md-img-0000", "images/a.jpg"], ["md-img-0001", "images/b.jpg"]],
);

const visual = {
	id: "vr-p0000-g0000",
	pageIdx: 0,
	label: "Fig. 1",
	caption: "Fig. 1. Complete caption",
	memberBlockIds: ["a", "b"],
	memberAssetPaths: ["images/a.jpg", "images/b.jpg"],
	memberMarkdownImageIds: ["md-img-0000", "md-img-0001"],
	samePageCaptionProjections: [{
		markdownImageId: "md-img-0001",
		text: "Fig. 1. Complete caption",
	}],
	anchorAssetPath: "images/a.jpg",
	display: { mode: "pdf-crop", bbox: [50, 50, 950, 700], padding: 6 },
	repairDecision: "auto",
	confidence: 0.96,
};
const prepared = markdown.prepareReaderMarkdown(
	"# Example\n\n![](images/a.jpg)\n\n<img src=\"images/b.jpg\">  \nFig. 1. Complete caption\n\n![](images/unrelated.jpg)\n",
	[visual],
);
assert.equal((prepared.match(/data-visual-id=/g) || []).length, 1);
assert.ok(!prepared.includes("images/a.jpg"));
assert.ok(!prepared.includes("images/b.jpg"));
assert.ok(!prepared.includes("Fig. 1. Complete caption"));
assert.ok(prepared.includes("images/unrelated.jpg"));

const budgetMarkdown = `# Budget\n\n![](images/a.jpg)\n\nFig. 1. Complete caption\n\n${"body\n".repeat(800_000)}`;
const budgetVisuals = Array.from({ length: 32 }, (_value, index) => ({
	...visual,
	id: `budget-${index}`,
	memberAssetPaths: index === 0 ? ["images/a.jpg"] : [`images/not-present-${index}.jpg`],
	memberMarkdownImageIds: index === 0 ? ["md-img-0000"] : [],
}));
const budgetStarted = performance.now();
const budgetPrepared = markdown.prepareReaderMarkdown(
	budgetMarkdown,
	budgetVisuals,
	undefined,
	{ removeUnmappedImages: true, maxProjectionWork: 1_000_000 },
);
const budgetElapsedMs = performance.now() - budgetStarted;
assert.ok(budgetElapsedMs < 2_500, `projection budget fallback took ${budgetElapsedMs.toFixed(1)} ms`);
assert.equal((budgetPrepared.match(/data-visual-id=/g) || []).length, 1);
assert.match(budgetPrepared, /Fig\. 1\. Complete caption/);
assert.match(budgetPrepared, /data-reader-page="1"/);

const pagedMarkdown = "# Example\n\nFirst page paragraph.\n\nSecond page paragraph.\n";
const pagedIndex = normalization.buildRuntimeViewerIndex([
	[{ type: "text", bbox: [0, 0, 100, 100], text: "First page paragraph." }],
	[{ type: "text", bbox: [0, 0, 100, 100], text: "Second page paragraph." }],
], pagedMarkdown);
const pagedPrepared = markdown.prepareReaderMarkdown(pagedMarkdown, [], pagedIndex);
assert.equal((pagedPrepared.match(/data-reader-page=/g) || []).length, 2);
assert.ok(pagedPrepared.indexOf('data-reader-page="1"') < pagedPrepared.indexOf("First page paragraph."));
assert.ok(pagedPrepared.indexOf('data-reader-page="2"') < pagedPrepared.indexOf("Second page paragraph."));
assert.ok(pagedPrepared.indexOf('data-reader-page="1"') < pagedPrepared.indexOf('data-reader-page="2"'));
const imageOnlyMarkdown = "# Example\n\nFirst page paragraph.\n\n![](images/only.jpg)\n\nThird page paragraph.\n";
const imageOnlyIndex = normalization.buildRuntimeViewerIndex([
	[{ type: "text", bbox: [0, 0, 100, 100], text: "First page paragraph." }],
	[{ type: "image", bbox: [0, 0, 100, 100], img_path: "images/only.jpg" }],
	[{ type: "text", bbox: [0, 0, 100, 100], text: "Third page paragraph." }],
], imageOnlyMarkdown);
const imageOnlyPrepared = markdown.prepareReaderMarkdown(imageOnlyMarkdown, [{
	...visual,
	id: "image-only-page",
	pageIdx: 1,
	memberAssetPaths: ["images/only.jpg"],
	memberMarkdownImageIds: ["md-img-0000"],
	anchorAssetPath: "images/only.jpg",
}], imageOnlyIndex);
assert.match(imageOnlyPrepared, /data-reader-page="1"/);
assert.doesNotMatch(imageOnlyPrepared, /data-reader-page="2"/);
assert.match(imageOnlyPrepared, /data-reader-page="3"/);
assert.equal(markdown.readerPageBoundaryIndex([8], [3], 1), 8);
assert.equal(markdown.readerPageBoundaryIndex([], [3, 8], 3), 8);
assert.equal(markdown.readerPageBoundaryIndex([], [], -1, true), 0);
assert.equal(markdown.readerPageBoundaryIndex([], [], 2, false), -1);
assert.equal(markdown.readerElementOffset(240, 450, 100), 590);
assert.equal(markdown.alignedReaderScrollTop(240, 450, 100, 18), 572);
assert.equal(markdown.alignedReaderScrollTop(0, 18, 0, 18), 0);
assert.equal(markdown.readerPageAtViewportTop([
	{ pageNumber: 1, top: -120, bottom: 80 },
	{ pageNumber: 2, top: 90, bottom: 180 },
], 0, 300, 3), 1);
assert.equal(markdown.readerPageAtViewportTop([
	{ pageNumber: 1, top: -200, bottom: -1 },
	{ pageNumber: 2, top: 12, bottom: 80 },
	{ pageNumber: 3, top: 90, bottom: 180 },
], 0, 300, 1), 2);
assert.equal(markdown.readerPageAtViewportTop([], 0, 300, 4), 4);

const nonAdjacentLowercaseBody = "ordinary lowercase body prose that is unique and must remain visible.";
const nonAdjacentPrepared = markdown.prepareReaderMarkdown(
	`![](images/lowercase.jpg)\n\nIntervening body boundary.\n\n${nonAdjacentLowercaseBody}\n`,
	[{
		...visual,
		id: "non-adjacent-lowercase",
		caption: nonAdjacentLowercaseBody,
		captionParts: [],
		memberAssetPaths: ["images/lowercase.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
		samePageCaptionProjections: [{
			markdownImageId: "md-img-0000",
			text: nonAdjacentLowercaseBody,
		}],
	}],
);
assert.ok(nonAdjacentPrepared.includes(nonAdjacentLowercaseBody));
assert.equal(markdown.visualLabelFromCaption("Fig. 3 | Benchmark", 1), "Fig. 3");
assert.equal(
	markdown.visualLabelFromCaption("Extended Data Figure 1 ｜\u202fBenchmark", 1),
	"Extended Data Figure 1",
);
assert.equal(markdown.selectVisualCaption(["Fig. 2 shows the model performance."]), "");
assert.equal(markdown.selectVisualCaption(["D F", "C", "E"]), "");
assert.equal(
	markdown.selectVisualCaption([
		"d Application 1: Anticipation and targeted discovery",
		"Application 2: Structure annotation of unknown metabolites",
		"Fig. 1 | Learning the language of metabolism. a, Schematic overview of DeepMet.",
	]),
	"Fig. 1 | Learning the language of metabolism. a, Schematic overview of DeepMet.",
);

const crossPageCaption = "Fig. 2 | Formal caption resolved from the following page.";
const crossPageRenderAnchor = "Target-page body anchor remains rendered.";
const crossPagePreparedMarkdown = `![](images/cross-page.jpg)  \n${crossPagePlaceholder}\n${"Body paragraph. ".repeat(120)}\n${crossPageCaption}\n${crossPageRenderAnchor}\n![](images/cross-page-after.jpg)\n`;
const crossPageCaptionStart = crossPagePreparedMarkdown.indexOf(crossPageCaption);
const crossPageRenderAnchorStart = crossPagePreparedMarkdown.indexOf(crossPageRenderAnchor);
const crossPagePrepared = markdown.prepareReaderMarkdown(
	crossPagePreparedMarkdown,
	[{
		...visual,
		id: "cross-page",
		caption: crossPageCaption,
		captionParts: [crossPageCaption, "Fig. 2 | See next page for caption"],
		captionSourceBlockIds: ["p0004-s000001"],
		captionSourceProjections: [{
			start: crossPageCaptionStart,
			end: crossPageCaptionStart + crossPageCaption.length + 1,
			text: crossPageCaption,
			suppress: true,
		}, {
			start: crossPageRenderAnchorStart,
			end: crossPageRenderAnchorStart + crossPageRenderAnchor.length + 1,
			text: crossPageRenderAnchor,
			suppress: false,
		}],
		captionSourceImageBounds: {
			beforeMarkdownImageId: "md-img-0000",
			afterMarkdownImageId: "md-img-0001",
		},
		captionPageIdx: 4,
		captionStatus: "complete",
		pageRange: [3, 4],
		samePageCaptionProjections: [{
			markdownImageId: "md-img-0000",
			text: crossPagePlaceholder,
		}],
		memberAssetPaths: ["images/cross-page.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
	}],
);
assert.equal((crossPagePrepared.match(/data-visual-id="cross-page"/g) || []).length, 1);
assert.ok(!crossPagePrepared.includes("See next page for caption"));
assert.ok(!crossPagePrepared.includes(crossPageCaption));
assert.ok(crossPagePrepared.includes("Body paragraph."));
assert.ok(crossPagePrepared.includes(crossPageRenderAnchor));

const crossPageBodyCollision = markdown.prepareReaderMarkdown(
	`![](images/cross-page-collision.jpg)\nBody prefix ${crossPageCaption} suffix stays.\n`,
	[{
		...visual,
		id: "cross-page-body-collision",
		caption: crossPageCaption,
		captionParts: [crossPageCaption],
		captionSourceBlockIds: ["p0004-s000001"],
		captionPageIdx: 4,
		captionStatus: "complete",
		pageRange: [3, 4],
		samePageCaptionProjections: [],
		memberAssetPaths: ["images/cross-page-collision.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
	}],
);
assert.ok(crossPageBodyCollision.includes(`Body prefix ${crossPageCaption} suffix stays.`));

const crossPageStandaloneBodyCollision = markdown.prepareReaderMarkdown(
	`![](images/cross-page-standalone-collision.jpg)\nIntervening body boundary.\n${crossPageCaption}\n`,
	[{
		...visual,
		id: "cross-page-standalone-body-collision",
		caption: crossPageCaption,
		captionParts: [crossPageCaption],
		captionSourceBlockIds: ["p0004-s000001"],
		captionSourceProjections: [],
		captionPageIdx: 4,
		captionStatus: "complete",
		pageRange: [3, 4],
		samePageCaptionProjections: [],
		memberAssetPaths: ["images/cross-page-standalone-collision.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
	}],
);
assert.ok(crossPageStandaloneBodyCollision.includes(`\n${crossPageCaption}\n`));

const normalizedCollisionArticle = [
	crossPageCaption,
	"![](images/cross-page-normalized-collision.jpg)",
	crossPagePlaceholder,
	"Intervening body proves that the matching standalone line is not the caption occurrence.",
	"![](images/cross-page-normalized-after.jpg)",
].join("\n") + "\n";
const normalizedCollisionIndex = normalization.buildRuntimeViewerIndex(
	[{
		type: "text",
		page_idx: 3,
		bbox: [50, 10, 950, 40],
		text: crossPageCaption,
	}, {
		type: "image",
		page_idx: 3,
		bbox: [50, 50, 950, 700],
		img_path: "images/cross-page-normalized-collision.jpg",
		image_caption: [crossPagePlaceholder],
	}, {
		type: "text",
		page_idx: 4,
		bbox: [50, 50, 950, 220],
		text: crossPageCaption,
	}, {
		type: "image",
		page_idx: 4,
		bbox: [50, 300, 950, 900],
		img_path: "images/cross-page-normalized-after.jpg",
	}],
	normalizedCollisionArticle,
);
const normalizedCollisionBlocks = normalizedCollisionIndex.pages.flatMap((page) => page.blocks);
const normalizedCollisionSource = normalizedCollisionIndex.pages[0].blocks[1];
const normalizedCollisionTarget = normalizedCollisionIndex.pages[1].blocks[0];
const normalizedCollisionDetails = markdown.resolveVisualCaptionDetails(
	[normalizedCollisionSource],
	normalizedCollisionBlocks,
	{
		schema_version: 1,
		algorithm_version: "visual-repair-v1.4",
		status: "complete",
		groups: [],
		caption_links: [{
			visual_block_id: normalizedCollisionSource.id,
			caption_block_ids: [normalizedCollisionTarget.id],
			source_page_idx: 3,
			target_page_idx: 4,
			figure_key: "figure:2",
			relation: "next_page_figure_caption",
			status: "complete",
		}],
		issues: [],
	},
	3,
);
assert.equal(normalizedCollisionDetails.captionSourceProjections.length, 1);
assert.deepEqual(normalizedCollisionDetails.captionSourceImageBounds, {
	beforeMarkdownImageId: "md-img-0000",
	afterMarkdownImageId: "md-img-0001",
});
const normalizedCollisionPrepared = markdown.prepareReaderMarkdown(
	normalizedCollisionArticle,
	[{
		...visual,
		id: "normalized-cross-page-body-collision",
		...normalizedCollisionDetails,
		memberAssetPaths: ["images/cross-page-normalized-collision.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
	}],
);
assert.ok(normalizedCollisionPrepared.includes(crossPageCaption));
assert.ok(!normalizedCollisionPrepared.includes(crossPagePlaceholder));

const staleCrossPageProjection = markdown.prepareReaderMarkdown(
	`![](images/cross-page-stale.jpg)\n${crossPageCaption}\n`,
	[{
		...visual,
		id: "cross-page-stale-projection",
		caption: crossPageCaption,
		captionParts: [crossPageCaption],
		captionSourceBlockIds: ["p0004-s000001"],
		captionSourceProjections: [{ start: 0, end: crossPageCaption.length + 1, text: crossPageCaption }],
		captionPageIdx: 4,
		captionStatus: "complete",
		pageRange: [3, 4],
		samePageCaptionProjections: [],
		memberAssetPaths: ["images/cross-page-stale.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
	}],
);
assert.ok(staleCrossPageProjection.includes(crossPageCaption));

const ext3Placeholder = "Extended Data Fig. 3 | See next page for caption.";
const ext3FormalCaption = "Extended Data Fig. 3 | A complete formal caption.";
const ext3Markdown = `![](images/ext3.jpg)\nq r ${ext3Placeholder}\n${ext3FormalCaption}\nBody stays.\n![](images/ext3-after.jpg)\n`;
const ext3FormalStart = ext3Markdown.indexOf(ext3FormalCaption);
const ext3Source = {
	...crossPageIndex.pages[0].blocks[0],
	id: "p0023-s000430",
	asset_path: "images/ext3.jpg",
	caption: {
		...crossPageIndex.pages[0].blocks[0].caption,
		text: `q r ${ext3Placeholder}`,
		parts: [{ text: `q r ${ext3Placeholder}`, kind: "other" }],
		figure_keys: ["extended-data-figure:3"],
		leading_figure_key: "extended-data-figure:3",
		next_page_figure_keys: ["extended-data-figure:3"],
		next_page_placeholders: [{
			index: 0,
			text: ext3Placeholder,
			figure_key: "extended-data-figure:3",
		}],
	},
};
const ext3Anchor = {
	...terminalAnchor,
	id: "p0024-s000437",
	text: {
		...terminalAnchor.text,
		text: ext3FormalCaption,
		figure_keys: ["extended-data-figure:3"],
		leading_figure_key: "extended-data-figure:3",
	},
	markdown_text_range: {
		offset_unit: "utf16-code-unit",
		start: ext3FormalStart,
		end: ext3FormalStart + ext3FormalCaption.length + 1,
	},
};
const ext3After = {
	...crossPageIndex.pages[1].blocks[2],
	id: "p0024-s000439",
	page_order: 1,
	asset_path: "images/ext3-after.jpg",
	markdown_image_ids: ["md-img-0001"],
};
const ext3Link = {
	...terminalLink,
	visual_block_id: ext3Source.id,
	caption_block_ids: [ext3Anchor.id],
	source_page_idx: 23,
	target_page_idx: 24,
	figure_key: "extended-data-figure:3",
};
const ext3Resolved = markdown.resolveVisualCaptionDetails(
	[ext3Source],
	[ext3Source, ext3Anchor, ext3After],
	{
		schema_version: 1,
		algorithm_version: "visual-repair-v1.4",
		status: "complete",
		groups: [],
		caption_links: [ext3Link],
		issues: [],
	},
	23,
);
assert.ok(ext3Resolved.captionParts.includes(ext3Placeholder));
assert.ok(!ext3Resolved.captionParts.includes(`q r ${ext3Placeholder}`));
assert.deepEqual(ext3Resolved.samePageCaptionProjections, [{
	markdownImageId: "md-img-0000",
	text: `q r ${ext3Placeholder}`,
	suppressText: ext3Placeholder,
}]);
const ext3Prepared = markdown.prepareReaderMarkdown(
	ext3Markdown,
	[{
		...visual,
		id: "ext3",
		...ext3Resolved,
		memberAssetPaths: ["images/ext3.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
	}],
);
assert.ok(!ext3Prepared.includes(ext3Placeholder));
assert.ok(!ext3Prepared.includes(ext3Anchor.text.text));
assert.ok(ext3Prepared.includes("q r "));
assert.ok(ext3Prepared.includes("Body stays."));
const duplicateExt3Placeholder = markdown.prepareReaderMarkdown(
	`![](images/ext3.jpg)\n${ext3Placeholder}\n${ext3Placeholder}\n`,
	[{
		...visual,
		id: "ext3-duplicate",
		caption: "",
		captionParts: [ext3Placeholder],
		memberAssetPaths: ["images/ext3.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
	}],
);
assert.equal((duplicateExt3Placeholder.match(/See next page for caption/g) || []).length, 2);

const repeated = markdown.prepareReaderMarkdown(
	"![](images/shared.jpg)\n\n![](images/shared.jpg)\n",
	[
		{ ...visual, id: "first", memberAssetPaths: ["images/shared.jpg"], memberMarkdownImageIds: ["md-img-0000"] },
		{ ...visual, id: "second", memberAssetPaths: ["images/shared.jpg"], memberMarkdownImageIds: ["md-img-0001"] },
	],
);
assert.equal((repeated.match(/data-visual-id="first"/g) || []).length, 1);
assert.equal((repeated.match(/data-visual-id="second"/g) || []).length, 1);

const containedOcrIndex = normalization.buildRuntimeViewerIndex(
	[
		{
			type: "image",
			page_idx: 2,
			bbox: [100, 100, 900, 700],
			img_path: "images/contained-label.jpg",
		},
		{
			type: "text",
			page_idx: 2,
			bbox: [120, 120, 145, 150],
			text: "b",
		},
		{
			type: "text",
			page_idx: 2,
			bbox: [100, 760, 900, 800],
			text: "c",
		},
	],
	"b\n![](images/contained-label.jpg)\n\nc\n\n正文保留 b。\n",
);
const containedBlocks = containedOcrIndex.pages[0].blocks;
const containedDetails = markdown.resolveVisualCaptionDetails(
	[containedBlocks[0]],
	containedBlocks,
	null,
	2,
);
assert.deepEqual(containedDetails.panelLabelProjections, [{
	markdownImageId: "md-img-0000",
	label: "b",
}]);
const containedPrepared = markdown.prepareReaderMarkdown(
	"b\n![](images/contained-label.jpg)\n\nc\n\n正文保留 b。\n",
	[{
		...visual,
		id: "contained-ocr",
		...containedDetails,
		memberBlockIds: [containedBlocks[0].id],
		memberAssetPaths: ["images/contained-label.jpg"],
		memberMarkdownImageIds: ["md-img-0000"],
	}],
);
assert.ok(!containedPrepared.startsWith("b\n"));
assert.ok(containedPrepared.includes("\nc\n"));
assert.ok(containedPrepared.includes("正文保留 b。"));

const config = read("src/config.ts");
const plugin = read("src/plugin.ts");
const view = read("src/views/mineru-reader.ts");
const loader = read("src/mineru/package-loader.ts");
const visualRepairSource = read("src/mineru/visual-repair.ts");
const pdfRenderer = read("src/mineru/pdf-renderer.ts");
const styles = read("styles.css");

assert.match(config, /MINERU_READER_VIEW_TYPE\s*=\s*"agent-dashboard-mineru-reader"/);
assert.match(plugin, /registerView\(MINERU_READER_VIEW_TYPE/);
assert.match(plugin, /id:\s*"open-mineru-reader"/);
assert.match(plugin, /"file-menu"/);
assert.match(plugin, /getLeaf\("tab"\)/);
assert.match(plugin, /mineruReaderActivationQueue/);
assert.match(plugin, /onLayoutReady\(\(\) => \{/);
assert.match(plugin, /this\.consolidateMineruReaderLeaves\(\)/);
assert.match(plugin, /getActiveViewOfType\(MineruReaderView\)/);
assert.match(plugin, /if \(leaf !== primary\) leaf\.detach\(\)/);
assert.match(view, /MarkdownRenderer\.render\([\s\S]*readerPackage\.articlePath,[\s\S]*this\.markdownComponent/);
assert.doesNotMatch(view, /agent-dashboard-mineru-article markdown-preview-view/);
assert.match(view, /loadPdfJs|MineruPdfRenderer/);
assert.match(view, /IntersectionObserver/);
assert.match(view, /applyMarkdownPage/);
assert.match(view, /readerPageAtViewportTop/);
assert.match(view, /data-reader-page-owner/);
assert.match(view, /document\.addEventListener\("scroll", schedulePageUpdate/);
assert.doesNotMatch(view, /setInterval\(/);
assert.doesNotMatch(view, /pagePollTimer|pageObserver/);
assert.doesNotMatch(view, /Math\.min\(paneRect\.bottom, scrollerRect\.bottom/);
assert.doesNotMatch(view, /selectVisual\(visualId, false, false\)/);
assert.match(view, /referenceAbortController/);
assert.match(view, /onReferenceEvent/);
assert.match(view, /markdownComponent\?\.unload/);
assert.match(view, /renderPdfOverlays/);
assert.match(view, /data-page-number/);
assert.match(view, /rootMargin:\s*"1400px 0px"/);
assert.match(view, /updateVisiblePage/);
assert.match(view, /scrollPdfToPage/);
assert.match(view, /followPdfReading/);
assert.match(view, /followVisualReading/);
assert.match(view, /pdfFollowInteractionSource/);
assert.match(view, /pausePdfFollowingForReferenceInteraction/);
assert.match(view, /this\.pdfFollowInteractionSource === "markdown"/);
assert.match(view, /pointerenter/);
assert.match(view, /跟随正文页 · 已暂停/);
assert.match(view, /pageHasSuspiciousBlankVisual/);
assert.match(view, /renderRetried/);
assert.match(view, /paintPdfImageCompatibilityLayer/);
assert.match(view, /imageFallback/);
assert.match(view, /block\.source_type !== "image"/);
assert.match(pdfRenderer, /convertToViewportPoint/);
assert.match(pdfRenderer, /loadBytes\(sourceBytes/);
assert.doesNotMatch(pdfRenderer, /vault\.readBinary/);
assert.match(pdfRenderer, /document\.numPages > MINERU_RESOURCE_LIMITS\.pdfPages/);
assert.match(pdfRenderer, /pageAspectRatio/);
assert.match(pdfRenderer, /canvasDimension/);
assert.match(pdfRenderer, /activeCanvasPixels/);
assert.match(view, /const firstPage = Math\.max\(1, this\.readerState\.pdfPage - 1\)/);
assert.match(view, /const lastPage = Math\.min\(this\.pdfRenderer\.numPages, this\.readerState\.pdfPage \+ 1\)/);
assert.doesNotMatch(view, /pageNumber <= this\.pdfRenderer\.numPages/);
assert.match(view, /verifiedResourceUrls/);
assert.match(view, /URL\.revokeObjectURL/);
assert.doesNotMatch(view, /await this\.app\.vault\.readBinary/);
assert.match(view, /if \(readerPackage\.sourceKind === "mineru"\)[\s\S]*?this\.resourceUrl\(assetPath\)/);
assert.doesNotMatch(view, /sourceKind === "markdown"\s*\?[^:]+:\s*this\.app\.vault\.getAbstractFileByPath/);
assert.doesNotMatch(pdfRenderer, /Array\.isArray\(transform\)/);
assert.match(view, /verifiedAssetBlobs\.get/);
assert.match(view, /URL\.createObjectURL\(blob\)/);
assert.doesNotMatch(view, /readAsDataURL|Uint8Array\.from/);
assert.match(loader, /new Blob\([\s\S]*?\[bytes\.buffer\]/);
assert.doesNotMatch(loader, /Uint8Array\.from\(bytes\)|bytes\.slice\(\)/);
assert.doesNotMatch(pdfRenderer, /sourceBytes\.slice\(\)/);
assert.match(view, /this\.readerPackage = null/);
assert.match(view, /auditCanvas/);
assert.match(view, /await compatibilityImage\.decode\(\)/);
assert.match(view, /agent-dashboard-mineru-pdf-image-layer/);
assert.match(view, /data-reader-page/);
assert.match(view, /materializePageAnchors/);
assert.match(view, /markerTargets/);
assert.match(view, /readerPageBoundaryIndex/);
assert.doesNotMatch(view, /visualTargets/);
assert.match(view, /markdown_text_range/);
assert.match(view, /syncStateForMode/);
assert.match(view, /alignedReaderScrollTop/);
assert.match(view, /readerMarkdownRestoreTarget/);
assert.doesNotMatch(view, /sourceKind === "mineru" \? this\.readerState\.currentVisualId/);
assert.match(view, /this\.readerState\.mode !== "pdf" \|\| this\.readerState\.followPdfReading/);
assert.match(view, /window\.getSelection\(\)/);
assert.match(view, /!selection\.isCollapsed && selection\.toString\(\)\.trim\(\)/);
assert.match(view, /target\.closest<HTMLElement>\("\[data-reader-page-owner\]"\)/);
assert.match(view, /文献阅读器/);
assert.match(view, /agent-dashboard-mineru-document-header/);
assert.match(view, /text:\s*readerPackage\.articlePath/);
assert.match(view, /text:\s*readerPackage\.title/);
assert.match(view, /agent-dashboard-mineru-thumbnail-preview/);
assert.doesNotMatch(view, /pageWrapper\.offsetTop|initialPage\.offsetTop/);
assert.doesNotMatch(view, /this\.readerState\.followReading/);
assert.doesNotMatch(view, /this\.readerState\.pdfPage = page;\s*void this\.renderReference\(\)/);
assert.match(view, /renderCrop/);
assert.match(view, /缺少包内 PDF，当前保留 MinerU 原始图块/);
assert.match(view, /图注第/);
assert.match(view, /MinerU 未提取到全部续栏文字/);
assert.match(loader, /viewer-index\.json/);
assert.match(loader, /visual-repair\.json/);
assert.equal(visualRepair.CURRENT_VISUAL_REPAIR_ALGORITHM, "visual-repair-v1.11");
assert.equal(visualRepair.isSupportedVisualRepairAlgorithm("visual-repair-v1.8"), true);
assert.equal(visualRepair.isSupportedVisualRepairAlgorithm("visual-repair-v0"), false);
assert.match(loader, /caption_links/);
assert.match(loader, /viewerHashesMatch/);
assert.match(loader, /validateVisualContracts/);
assert.match(visualRepairSource, /captionLinkMatchesBlocks/);
assert.match(visualRepairSource, /validateVisualContracts/);
assert.match(loader, /reclassifyRuntimeRunningHeaders\(viewerIndex\)/);
assert.match(loader, /verifyManifestOutputs/);
assert.match(loader, /await verifyManifestOutputs[\s\S]*?derivePassiveMineruMarkdown/);
assert.match(view, /sourceMarkdownDisposition === "runtime-derived"[\s\S]*?return;[\s\S]*?openReaderSourceMarkdown/);
assert.match(loader, /readOptionalDerivedJson/);
assert.match(loader, /manifest\.json 已登记该文件，但文件不存在/);
assert.match(loader, /captionRecord\.items \?\? captionRecord\.parts/);
assert.match(loader, /captionParts\.map\(\(part\) => part\.text\)\.join\(" "\)/);
assert.match(loader, /captionText \|\| captionParts\.length \|\| fallback\?\.caption/);
assert.match(loader, /rawRole === "marginalia" \? "discarded"/);
assert.match(pdfRenderer, /pageGeneration/);
assert.match(pdfRenderer, /PDF page render superseded/);
assert.match(pdfRenderer, /pageTasks = new Set/);
assert.match(pdfRenderer, /cropTasks = new Set/);
assert.doesNotMatch(pdfRenderer, /page\.cleanup\?\.\(\)/);
assert.match(pdfRenderer, /clearResources/);
assert.match(view, /defaultStateForSettings/);
assert.match(view, /mineruReaderDefaultMode/);
assert.match(view, /mineruReaderFollowPdfReading/);
assert.match(view, /mineruReaderSplitRatio/);
assert.match(pdfRenderer, /setRenderQuality/);
assert.match(pdfRenderer, /density \* 1\.5/);
assert.match(view, /包内 PDF 无法加载，已保留 Markdown 与原始图片阅读/);
assert.match(styles, /\.agent-dashboard-mineru-workspace/);
assert.match(styles, /\.agent-dashboard-mineru-layout-box/);
assert.match(styles, /\.agent-dashboard-mineru-layout-box\.is-visual,[\s\S]*?background:\s*transparent/);
assert.match(styles, /\.agent-dashboard-mineru-pdf-page-placeholder/);
assert.match(styles, /scrollbar-gutter:\s*stable/);
assert.match(styles, /\.agent-dashboard-mineru-page-anchor/);
assert.match(styles, /\.agent-dashboard-mineru-mode-follow/);
assert.match(styles, /\.agent-dashboard-mineru-document-header/);
assert.match(styles, /\.agent-dashboard-mineru-thumbnail-preview img\s*\{[\s\S]*?object-fit:\s*contain/);
assert.match(styles, /button\.agent-dashboard-mineru-thumbnail\s*\{[\s\S]*?min-height:\s*104px;[\s\S]*?overflow:\s*hidden/);
assert.match(styles, /\.agent-dashboard-mineru-article \*\s*\{[\s\S]*?user-select:\s*text !important;[\s\S]*?-webkit-user-select:\s*text !important/);
assert.match(styles, /\.agent-dashboard-mineru-article ::selection/);
assert.match(styles, /@container \(max-width: 680px\)/);
assert.match(styles, /grid-template-columns: minmax\(0, var\(--agent-dashboard-mineru-markdown-width/);

console.log("DASHBOARD_MINERU_READER_TEST_OK");
