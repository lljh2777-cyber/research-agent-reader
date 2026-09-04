export type LearningModuleId =
	| "paper"
	| "question"
	| "background"
	| "design"
	| "methods"
	| "results"
	| "conclusion";

export type LearningBranchSide = "above" | "below";
export type LearningBranchStatus = "draft" | "sent";

export interface LearningSection {
	heading: string;
	level: number;
	body: string;
}

export interface LearningEvidenceRef {
	id: string;
	label: string;
	detail: string;
	kind: "section" | "figure" | "source";
}

export interface LearningModule {
	id: LearningModuleId;
	index: number;
	label: string;
	kicker: string;
	guidance: string;
	sectionHeadings: string[];
	excerpt: string;
	evidence: LearningEvidenceRef[];
}

export interface LearningBranch {
	id: string;
	parentId: LearningModuleId;
	question: string;
	side: LearningBranchSide;
	status: LearningBranchStatus;
}

export interface LearningSessionState {
	articlePath: string;
	activeModuleId: LearningModuleId;
	selectedNodeId: string;
	completedModuleIds: LearningModuleId[];
	branches: LearningBranch[];
}

interface ModuleDefinition {
	id: LearningModuleId;
	label: string;
	kicker: string;
	guidance: string;
	keywords: RegExp;
}

export const LEARNING_MODULE_DEFINITIONS: readonly ModuleDefinition[] = [
	{
		id: "paper",
		label: "论文",
		kicker: "阅读起点",
		guidance: "先确认论文对象、研究范围与全文结构，建立后续讲解的共同坐标。",
		keywords: /^(?:abstract|摘要|summary|概述|highlights?)$/i,
	},
	{
		id: "question",
		label: "研究问题",
		kicker: "为什么研究",
		guidance: "识别作者真正试图回答的问题，并区分研究动机、假设与具体目标。",
		keywords: /(?:research question|objective|aims?|purpose|motivation|研究问题|研究目的|研究目标|研究动机)/i,
	},
	{
		id: "background",
		label: "背景概念",
		kicker: "需要先知道什么",
		guidance: "补齐理解论文所需的领域背景、关键概念和已有工作。",
		keywords: /(?:introduction|background|related work|literature review|引言|背景|相关工作|文献综述)/i,
	},
	{
		id: "design",
		label: "实验设计",
		kicker: "如何回答问题",
		guidance: "梳理研究对象、分组、变量、数据来源和对照关系，判断设计能支持什么结论。",
		keywords: /(?:study design|experimental design|participants?|cohort|dataset|materials|实验设计|研究设计|研究对象|队列|数据集|材料)/i,
	},
	{
		id: "methods",
		label: "方法",
		kicker: "如何得到证据",
		guidance: "理解关键技术路线、分析步骤、统计方法及其假设。",
		keywords: /(?:methods?|methodology|analysis|protocol|statistics?|方法|方法学|分析流程|统计)/i,
	},
	{
		id: "results",
		label: "核心结果",
		kicker: "证据说明什么",
		guidance: "沿主要图表和结果段落核对核心发现，分清观察结果与作者解释。",
		keywords: /(?:results?|findings?|experiments?|结果|发现|实验结果)/i,
	},
	{
		id: "conclusion",
		label: "结论与局限",
		kicker: "能走多远",
		guidance: "收束主要结论、适用边界、局限性和仍待解决的问题。",
		keywords: /(?:discussion|conclusions?|limitations?|future work|讨论|结论|局限|展望)/i,
	},
];

const MAX_BRANCHES = 80;
const MAX_QUESTION_LENGTH = 500;

function cleanInlineMarkdown(value: string): string {
	return value
		.replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/[`*_~>#|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function trimExcerpt(value: string, limit = 280): string {
	const cleaned = cleanInlineMarkdown(value);
	if (cleaned.length <= limit) return cleaned;
	return `${cleaned.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function parseLearningSections(markdown: string): LearningSection[] {
	const withoutFrontmatter = markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
	const matches = Array.from(withoutFrontmatter.matchAll(/^(#{1,3})\s+(.+?)\s*$/gm));
	if (!matches.length) {
		return [{ heading: "全文", level: 1, body: withoutFrontmatter.trim() }];
	}
	return matches.map((match, index) => {
		const start = (match.index || 0) + match[0].length;
		const end = matches[index + 1]?.index ?? withoutFrontmatter.length;
		return {
			heading: cleanInlineMarkdown(match[2]),
			level: match[1].length,
			body: withoutFrontmatter.slice(start, end).trim(),
		};
	});
}

function selectedSections(
	definition: ModuleDefinition,
	sections: readonly LearningSection[],
): LearningSection[] {
	const exact = sections.filter((section) => definition.keywords.test(section.heading));
	if (exact.length) return exact.slice(0, 3);
	const fallbackKeywords: Partial<Record<LearningModuleId, RegExp>> = {
		paper: /(?:abstract|摘要|summary|概述|introduction|引言)/i,
		question: /(?:abstract|摘要|introduction|引言|background|背景)/i,
		background: /(?:introduction|引言|background|背景|related work|相关工作)/i,
		design: /(?:methods?|方法|materials?|材料|dataset|数据)/i,
		methods: /(?:methods?|方法|materials?|材料|analysis|分析)/i,
		results: /(?:results?|结果|findings?|发现)/i,
		conclusion: /(?:discussion|讨论|conclusions?|结论|limitations?|局限)/i,
	};
	const fallback = fallbackKeywords[definition.id];
	const nearby = fallback
		? sections.filter((section) => fallback.test(section.heading)).slice(0, 2)
		: [];
	if (nearby.length) return nearby;
	return definition.id === "paper" ? sections.slice(0, 2) : [];
}

export function buildLearningModules(
	markdown: string,
	articlePath: string,
	visuals: readonly { id: string; label: string; caption: string; pageIdx: number }[] = [],
): LearningModule[] {
	const sections = parseLearningSections(markdown);
	return LEARNING_MODULE_DEFINITIONS.map((definition, index) => {
		const matched = selectedSections(definition, sections);
		const sectionEvidence: LearningEvidenceRef[] = matched.map((section, evidenceIndex) => ({
			id: `${definition.id}-section-${evidenceIndex}`,
			label: section.heading,
			detail: trimExcerpt(section.body, 360) || "该章节暂无可提取正文。",
			kind: "section",
		}));
		const figureEvidence: LearningEvidenceRef[] = definition.id === "results"
			? visuals.slice(0, 3).map((visual) => ({
				id: `${definition.id}-visual-${visual.id}`,
				label: `${visual.label} · 第 ${visual.pageIdx + 1} 页`,
				detail: trimExcerpt(visual.caption, 360) || "图注尚未提供可读文本。",
				kind: "figure" as const,
			}))
			: [];
		const evidence = [...sectionEvidence, ...figureEvidence];
		if (definition.id === "paper") {
			evidence.unshift({
				id: "paper-source",
				label: "当前原文",
				detail: articlePath,
				kind: "source",
			});
		}
		return {
			id: definition.id,
			index,
			label: definition.label,
			kicker: definition.kicker,
			guidance: definition.guidance,
			sectionHeadings: matched.map((section) => section.heading),
			excerpt: trimExcerpt(matched.map((section) => section.body).join(" ")),
			evidence,
		};
	});
}

function isModuleId(value: unknown): value is LearningModuleId {
	return LEARNING_MODULE_DEFINITIONS.some((definition) => definition.id === value);
}

export function createLearningSessionState(articlePath = ""): LearningSessionState {
	return {
		articlePath,
		activeModuleId: "paper",
		selectedNodeId: "paper",
		completedModuleIds: [],
		branches: [],
	};
}

export function normalizeLearningSessionState(value: unknown): LearningSessionState {
	const record = value !== null && typeof value === "object"
		? value as Record<string, unknown>
		: {};
	const activeModuleId = isModuleId(record.activeModuleId) ? record.activeModuleId : "paper";
	const completedModuleIds = Array.isArray(record.completedModuleIds)
		? Array.from(new Set(record.completedModuleIds.filter(isModuleId)))
		: [];
	const rawBranches = Array.isArray(record.branches) ? record.branches.slice(0, MAX_BRANCHES) : [];
	const branches: LearningBranch[] = [];
	for (const [index, value] of rawBranches.entries()) {
		if (value === null || typeof value !== "object") continue;
		const branch = value as Record<string, unknown>;
		if (!isModuleId(branch.parentId)) continue;
		const question = String(branch.question || "").trim().slice(0, MAX_QUESTION_LENGTH);
		if (!question) continue;
		branches.push({
			id: String(branch.id || `question-${index + 1}`).slice(0, 120),
			parentId: branch.parentId,
			question,
			side: branch.side === "below" ? "below" : "above",
			status: branch.status === "sent" ? "sent" : "draft",
		});
	}
	const selectedNodeId = String(record.selectedNodeId || activeModuleId);
	return {
		articlePath: String(record.articlePath || "").trim(),
		activeModuleId,
		selectedNodeId: isModuleId(selectedNodeId)
			|| branches.some((branch) => branch.id === selectedNodeId)
			? selectedNodeId
			: activeModuleId,
		completedModuleIds,
		branches,
	};
}

export function nextLearningModuleId(current: LearningModuleId): LearningModuleId {
	const index = LEARNING_MODULE_DEFINITIONS.findIndex((definition) => definition.id === current);
	return LEARNING_MODULE_DEFINITIONS[Math.min(index + 1, LEARNING_MODULE_DEFINITIONS.length - 1)].id;
}

export function createLearningBranch(
	parentId: LearningModuleId,
	question: string,
	existingBranches: readonly LearningBranch[],
	id = `question-${Date.now()}`,
): LearningBranch | null {
	const normalizedQuestion = question.trim().replace(/\s+/g, " ").slice(0, MAX_QUESTION_LENGTH);
	if (!normalizedQuestion) return null;
	const siblingCount = existingBranches.filter((branch) => branch.parentId === parentId).length;
	return {
		id,
		parentId,
		question: normalizedQuestion,
		side: siblingCount % 2 === 0 ? "above" : "below",
		status: "draft",
	};
}

export function buildLearningQuestionPrompt(
	articlePath: string,
	module: LearningModule,
	question: string,
): string {
	const sectionContext = module.sectionHeadings.length
		? `优先检查章节：${module.sectionHeadings.join("、")}。`
		: "当前结构化导读未匹配到明确章节，请在全文中检索依据。";
	return [
		`我正在阅读文献 \`${articlePath}\`，当前主线模块是“${module.label}”。`,
		sectionContext,
		`问题：${question.trim()}`,
		"请先基于当前文献与知识库证据回答，明确区分原文证据、知识库补充和推断；给出可回到原文核对的位置。",
	].join("\n");
}
