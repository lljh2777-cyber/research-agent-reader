import { normalizePath, type App, type TFile } from "obsidian";

import { ACTIONS } from "../actions";
import type { PluginHost, VaultRecord } from "../types/contracts";
import { isExcludedVaultHealthPath, isVaultHealthScopePath } from "./vault-lint";

export interface DashboardVaultChange {
	type: "upsert" | "delete";
	path: string;
	file?: TFile | null;
}

interface PaperDepth {
	metadataOnly: number;
	ingested: number;
	abstractLevel: number;
	xray: number;
	needXray: number;
}

interface KnowledgeGap {
	id?: string;
	type: string;
	title: string;
	severity: "high" | "medium" | "low";
	score: number;
	actionId: string;
	actionInput?: string;
	source?: string;
	evidence?: string[];
	status?: string;
}

interface Coverage {
	methodNodes: number;
	synthesisNodes: number;
	missingMethodPages: number;
	recentHubs: string[];
}

interface LinkReport {
	total: number;
	broken: Array<{ source: string; target: string }>;
}

interface AgentRun {
	agent: string;
	task: string;
	status: string;
	time: string;
	runId?: string;
}

interface MethodGapCandidate {
	title: string;
	paths: string[];
}

interface DashboardDataHost extends PluginHost {}

export class DashboardDataService {
	private readonly app: App;
	private readonly plugin: DashboardDataHost;
	private recordByPath: Map<string, VaultRecord>;
	private initialized: boolean;
	private loadVersion: number;

	constructor(app: App, plugin: DashboardDataHost) {
		this.app = app;
		this.plugin = plugin;
		this.recordByPath = new Map();
		this.initialized = false;
		this.loadVersion = 0;
	}

	async load(changes: DashboardVaultChange[] = []) {
		const version = ++this.loadVersion;
		const nextRecords = new Map(this.recordByPath);
		if (!this.initialized) {
			const files = this.app.vault.getMarkdownFiles()
				.filter((file) => !this.isExcludedMaintenancePath(file.path));
			const records = await Promise.all(files.map((file) => this.readRecord(file)));
			if (version !== this.loadVersion) return null;
			nextRecords.clear();
			records.forEach((record) => nextRecords.set(record.path, record));
		} else {
			for (const change of changes) {
				if (this.isExcludedMaintenancePath(change.path)) {
					nextRecords.delete(normalizePath(change.path));
					continue;
				}
				if (change.type === "delete") {
					nextRecords.delete(normalizePath(change.path));
					continue;
				}
				if (change.file?.extension === "md") {
					const record = await this.readRecord(change.file);
					nextRecords.set(record.path, record);
				}
			}
			if (version !== this.loadVersion) return null;
		}
		this.recordByPath = nextRecords;
		this.initialized = true;
		const records = [...nextRecords.values()];
		const recordByPath = new Map(records.map((record) => [record.path, record]));
		const sourceRecords = records.filter((record) => record.path.startsWith("wiki/sources/"));
		const methodRecords = records.filter((record) => record.path.startsWith("wiki/methods/"));
		const synthesisRecords = records.filter((record) => record.path.startsWith("wiki/synthesis/"));
		const codeProjectRecords = records.filter((record) => record.path.startsWith("wiki/code/projects/") || record.type === "code-project");
		const codeScriptRecords = records.filter((record) => record.path.startsWith("wiki/code/scripts/") || record.type === "code-script");
		const codeRecords = [...codeProjectRecords, ...codeScriptRecords];
		const linkReport = this.computeLinkReport(records);
		const missingFrontmatter = records.filter((record) => record.path.startsWith("wiki/") && !record.hasFrontmatter).length;
		const paperDepth = this.computePaperDepth(sourceRecords);
		const staticReadCount = codeRecords.filter((record) => record.frontmatter.analysis_depth === "static-read").length;
		const activity = this.computeActivity(records);
		const agentRuns = await this.computeAgentRuns(recordByPath);
		const knowledgeGaps = await this.computeKnowledgeGaps(records, sourceRecords);
		const coverage = this.computeCoverage(methodRecords, synthesisRecords, knowledgeGaps);
		const okf = this.computeOkfReadiness(records, linkReport, missingFrontmatter, coverage);
		const lintStatus = this.plugin.getLintStatus();
		const latestHealthScopeMtime = records
			.filter((record) => isVaultHealthScopePath(record.path))
			.reduce((latest, record) => Math.max(latest, record.mtime || 0), 0);
		const lintGeneratedAt = lintStatus.latest ? new Date(lintStatus.latest.generated_at).getTime() : 0;
		const lintSummary = lintStatus.latest?.summary || null;
		const reportedHealthScore = Number(lintSummary?.score);
		const healthScore = lintSummary && Number.isFinite(reportedHealthScore)
			? reportedHealthScore
			: null;
		const lintStale = Boolean(
			lintSummary
			&& Number.isFinite(lintGeneratedAt)
			&& lintGeneratedAt < latestHealthScopeMtime,
		);
		const now = new Date();

		const result = {
			header: {
				scope: "研究知识库",
				title: "文献知识库智能体控制台",
				status: "本地",
				vault: this.app.vault.getName(),
				lastScan: `上次扫描 ${this.formatTime(now)}`,
			},
			actions: ACTIONS,
			metrics: [
				{
					label: "知识库健康",
					value: healthScore === null ? "—" : String(healthScore),
					unit: "",
					tone: healthScore === null ? "neutral" : healthScore >= 90 ? "good" : healthScore >= 75 ? "warn" : "danger",
					detail: lintSummary
						? `上次体检 ${this.formatExportTime(lintStatus.latest?.generated_at)}：${lintSummary.errors} 个错误，${lintSummary.warnings} 个警告${lintStale ? "；此后知识库有更新" : ""}`
						: lintStatus.error
							? "上次体检报告无法读取"
							: "尚无体检结果，请运行知识库体检",
				},
				{
					label: "文献流程",
					value: String(sourceRecords.length),
					unit: "",
					tone: paperDepth.needXray > 0 ? "warn" : "good",
					detail: `${paperDepth.ingested} 个已入库，${paperDepth.abstractLevel} 个 abstract-level，${paperDepth.needXray} 个待 x-ray`,
				},
				{
					label: "代码笔记",
					value: String(codeProjectRecords.length + codeScriptRecords.length),
					unit: "",
					tone: "neutral",
					detail: `${codeProjectRecords.length} 个项目，${staticReadCount} 个 static-read 笔记`,
				},
				{
					label: "知识枢纽",
					value: String(methodRecords.length + synthesisRecords.length),
					unit: "",
					tone: coverage.missingMethodPages > 0 ? "warn" : "good",
					detail: `${methodRecords.length} 个方法页，${synthesisRecords.length} 个综合页`,
				},
			],
			activity,
			agentRuns,
			knowledgeGaps,
			processingDepth: this.computeProcessingDepth(paperDepth, staticReadCount),
			coverage,
			okf,
		};
		return version === this.loadVersion ? result : null;
	}

	isExcludedMaintenancePath(value: string): boolean {
		return isExcludedVaultHealthPath(value);
	}

	async readRecord(file: TFile): Promise<VaultRecord> {
		const text = await this.app.vault.cachedRead(file);
		const cachedFrontmatter = this.app.metadataCache?.getFileCache?.(file)?.frontmatter;
		const frontmatter = cachedFrontmatter && typeof cachedFrontmatter === "object"
			? { ...cachedFrontmatter }
			: this.parseFrontmatter(text);
		return {
			file,
			path: normalizePath(file.path),
			name: file.basename,
			text,
			frontmatter,
			hasFrontmatter: Boolean(cachedFrontmatter)
				|| (text.startsWith("---") && Object.keys(frontmatter).length > 0),
			type: String(frontmatter.type || this.inferType(file.path)),
			tags: this.normalizeTags(frontmatter.tags),
			mtime: file.stat.mtime,
			ctime: file.stat.ctime,
		};
	}

	parseFrontmatter(text: string): Record<string, unknown> {
		if (!text.startsWith("---")) {
			return {};
		}
		const end = text.indexOf("\n---", 3);
		if (end === -1) {
			return {};
		}
		const raw = text.slice(3, end).trim();
		const data: Record<string, unknown> = {};
		let currentKey = "";
		for (const line of raw.split(/\r?\n/)) {
			const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
			if (keyMatch) {
				currentKey = keyMatch[1];
				data[currentKey] = this.parseYamlValue(keyMatch[2]);
				continue;
			}
			const listMatch = line.match(/^\s*-\s+(.*)$/);
			if (listMatch && currentKey) {
				if (!Array.isArray(data[currentKey])) {
					data[currentKey] = data[currentKey] ? [data[currentKey]] : [];
				}
				(data[currentKey] as unknown[]).push(this.cleanYamlScalar(listMatch[1]));
			}
		}
		return data;
	}

	parseYamlValue(value: string): string | string[] {
		const trimmed = value.trim();
		if (!trimmed) {
			return "";
		}
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			return trimmed
				.slice(1, -1)
				.split(",")
				.map((item) => this.cleanYamlScalar(item))
				.filter(Boolean);
		}
		return this.cleanYamlScalar(trimmed);
	}

	cleanYamlScalar(value: unknown): string {
		return String(value).trim().replace(/^['"]|['"]$/g, "");
	}

	normalizeTags(tags: unknown): string[] {
		if (Array.isArray(tags)) {
			return tags.map((tag) => String(tag));
		}
		if (typeof tags === "string" && tags.length > 0) {
			return tags.split(/[,\s]+/).filter(Boolean);
		}
		return [];
	}

	inferType(path: string): string {
		const normalized = normalizePath(path);
		if (normalized.startsWith("wiki/sources/")) return "source";
		if (normalized.startsWith("wiki/methods/")) return "method";
		if (normalized.startsWith("wiki/synthesis/")) return "synthesis";
		if (normalized.startsWith("wiki/concepts/")) return "concept";
		if (normalized.startsWith("wiki/datasets/")) return "dataset";
		if (normalized.startsWith("wiki/code/projects/")) return "code-project";
		if (normalized.startsWith("wiki/code/scripts/")) return "code-script";
		return "note";
	}

	computePaperDepth(sourceRecords: VaultRecord[]): PaperDepth {
		const counts = {
			metadataOnly: 0,
			ingested: 0,
			abstractLevel: 0,
			xray: 0,
			needXray: 0,
		};
		for (const record of sourceRecords) {
			const status = String(record.frontmatter.status || "").toLowerCase();
			const depth = String(record.frontmatter.analysis_depth || "").toLowerCase();
			const tags = record.tags.map((tag) => tag.toLowerCase());
			const isXray = status === "x-ray" || status === "xray" || depth === "x-ray" || tags.includes("x-ray");
			const isAbstract = status === "abstract-level" || depth === "abstract-level";
			if (isXray) {
				counts.xray += 1;
			} else if (isAbstract) {
				counts.abstractLevel += 1;
				counts.needXray += 1;
			} else {
				counts.metadataOnly += 1;
				counts.needXray += 1;
				if (status === "ingested" || !status) {
					counts.ingested += 1;
				}
			}
		}
		return counts;
	}

	computeProcessingDepth(paperDepth: PaperDepth, staticReadCount: number) {
		const rows = [
			{ label: "metadata-only", count: paperDepth.metadataOnly },
			{ label: "abstract-level", count: paperDepth.abstractLevel },
			{ label: "x-ray", count: paperDepth.xray },
			{ label: "static-read", count: staticReadCount },
		];
		const total = rows.reduce((sum, row) => sum + row.count, 0) || 1;
		return rows.map((row) => ({
			...row,
			percent: Math.round((row.count / total) * 100),
		}));
	}

	computeActivity(records: VaultRecord[]) {
		const now = new Date();
		const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
		const start = new Date(2026, 6, 1);
		const counts = new Map<string, number>();
		const tracks = new Map<string, string>();

		for (const record of records) {
			if (!record.path.startsWith("wiki/")) {
				continue;
			}
			const date = new Date(record.mtime || record.ctime);
			if (date < start || date > end) {
				continue;
			}
			const key = this.toISODate(date);
			const track = this.trackForRecord(record);
			counts.set(key, (counts.get(key) || 0) + 1);
			tracks.set(key, track);
		}

		const days = [];
		const paddedStart = this.mondayStart(start);
		const paddedEnd = this.sundayEnd(end);
		for (let cursor = new Date(paddedStart); cursor <= paddedEnd; cursor = this.addDays(cursor, 1)) {
			const key = this.toISODate(cursor);
			const count = counts.get(key) || 0;
			const inRange = cursor >= start && cursor <= end;
			days.push({
				date: key,
				count,
				inRange,
				level: inRange ? this.countToLevel(count) : 0,
				track: tracks.get(key) || "note",
			});
		}

		return {
			title: "研究活动热力图",
			rangeLabel: `${Array.from(counts.values()).filter((count) => count > 0).length} 个活跃日，${this.formatMonthYear(start)}-${this.formatMonthYear(end)}`,
			tracks: ["文献", "方法", "综合", "代码"],
			days,
		};
	}

	trackForRecord(record: VaultRecord): string {
		if (record.path.startsWith("wiki/sources/")) return "文献";
		if (record.path.startsWith("wiki/methods/")) return "方法";
		if (record.path.startsWith("wiki/synthesis/")) return "综合";
		if (record.path.startsWith("wiki/code/")) return "代码";
		return "笔记";
	}

	countToLevel(count: number): number {
		if (count >= 12) return 4;
		if (count >= 7) return 3;
		if (count >= 3) return 2;
		if (count >= 1) return 1;
		return 0;
	}

	async computeAgentRuns(recordByPath: Map<string, VaultRecord>): Promise<AgentRun[]> {
		const logRecord = recordByPath.get("wiki/log.md");
		const persistedRuns = this.plugin.getTaskRuns().map((run) => ({
			agent: run.agent,
			task: run.summary || run.label,
			status: run.status,
			time: this.formatRunTime(run.startedAt),
			runId: run.id,
		}));
		const logRuns: AgentRun[] = [];
		if (logRecord) {
			const headingPattern = /^##\s+\[([^\]]+)\]\s+([^|\n]+)(?:\|\s*(.+))?$/gm;
			let match;
			while ((match = headingPattern.exec(logRecord.text)) !== null) {
				const date = match[1].trim();
				const category = match[2].trim();
				const title = (match[3] || category).trim();
				logRuns.push({
					agent: this.agentForCategory(category),
					task: title,
					status: "done",
					time: date,
				});
			}
		}
		const combined = [...persistedRuns, ...logRuns.reverse()].slice(0, 6);
		if (combined.length > 0) {
			return combined;
		}
		return [{ agent: "research-vault", task: "尚无智能体运行记录", status: "planned", time: "待处理" }];
	}

	formatRunTime(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "未知时间";
		return new Intl.DateTimeFormat("zh-CN", {
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(date);
	}

	agentForCategory(category: string): string {
		const value = category.toLowerCase();
		if (value.includes("x-ray")) return "paper_xray";
		if (value.includes("code")) return "code_reader";
		if (value.includes("lint") || value.includes("maintenance")) return "research-vault-lint";
		if (value.includes("synthesis")) return "research-vault-synthesis";
		if (value.includes("source")) return "research-vault-source-note";
		if (value.includes("ingest")) return "research-vault-ingest";
		return "research-vault";
	}

	async computeKnowledgeGaps(
		records: VaultRecord[],
		sourceRecords: VaultRecord[],
	): Promise<KnowledgeGap[]> {
		const candidates: KnowledgeGap[] = [];
		const methodCandidates = new Map<string, MethodGapCandidate>();
		for (const record of records) {
			const matches = record.text.matchAll(/[-*]\s+([^。\n]+?)（待建方法页/g);
			for (const match of matches) {
				const title = match[1].replace(/\[\[[^\]]+\]\]/g, "").trim();
				const key = this.normalizeGapKey(title);
				if (!key || this.methodHubExists(records, title)) continue;
				const existing = methodCandidates.get(key) || { title, paths: [] };
				existing.paths.push(record.path);
				methodCandidates.set(key, existing);
			}
		}
		for (const candidate of methodCandidates.values()) {
			candidates.push({
				id: this.makeGapId("method", candidate.title),
				type: "method",
				title: `待建方法页：${candidate.title}`,
				severity: "medium",
				score: 40 + candidate.paths.length * 5,
				source: "code-handoff",
				evidence: candidate.paths,
				status: "open",
				actionId: "synthesis",
				actionInput: this.buildMethodGapInput(candidate.title),
			});
		}
		const inboundCounts = this.computeInboundReferenceCounts(records);
		const needXray = sourceRecords
			.filter((record) => {
				const status = String(record.frontmatter.status || "").toLowerCase();
				const tags = record.tags.map((tag) => tag.toLowerCase());
				return status !== "x-ray" && status !== "xray" && !tags.includes("x-ray");
			})
			.map((record) => ({
				record,
				score: this.paperGapScore(record, inboundCounts.get(record.path) || 0),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, 4);
		for (const item of needXray) {
			const record = item.record;
			const title = record.frontmatter.title || record.name;
			candidates.push({
				id: this.makeGapId("paper", record.path),
				type: "paper",
				title: `待 x-ray 深读：${title}`,
				severity: "high",
				score: item.score,
				source: "processing-depth",
				evidence: [record.path],
				status: "open",
				actionId: "pdf-xray",
				actionInput: this.buildPaperGapInput(record, title),
			});
		}
		const lintFindings = this.plugin.getLintStatus().latest?.findings;
		for (const finding of Array.isArray(lintFindings) ? lintFindings : []) {
			if (!["error", "warning"].includes(finding.severity)) continue;
			const actionId = finding.fixable === true ? "vault-lint-fix" : "vault-lint";
			candidates.push({
				id: this.makeGapId("lint", `${finding.category}:${finding.code}:${finding.path}`),
				type: "quality",
				title: `${finding.path || finding.category}：${finding.message}`,
				severity: finding.severity === "error" ? "high" : "medium",
				score: finding.severity === "error" ? 95 : 55,
				source: "lint",
				evidence: [finding.path].filter(Boolean),
				status: "open",
				actionId,
				actionInput: finding.fixable === true
					? "读取最新知识库体检报告，逐项核验并修复其中仍然存在且属于低风险的 fixable finding；完成后重新体检。"
					: "",
			});
		}
		const okfStatus = this.plugin.getOkfExportStatus();
		if (!okfStatus.exporterAvailable) {
			candidates.push({ type: "okf", title: "OKF 导出器不可用", severity: "high", score: 90, actionId: "okf-export" });
		} else if (okfStatus.error) {
			candidates.push({ type: "okf", title: "OKF 最近导出状态无法读取", severity: "high", score: 85, actionId: "okf-export" });
		} else if (!okfStatus.latest) {
			candidates.push({ type: "okf", title: "尚未生成 OKF bundle", severity: "medium", score: 45, actionId: "okf-export" });
		} else if (!okfStatus.latest.conformant) {
			candidates.push({ type: "okf", title: "最近的 OKF bundle 未通过 conformance", severity: "high", score: 80, actionId: "okf-export" });
		} else if (Number(okfStatus.latest.unresolved_link_count || 0) > 0) {
			candidates.push({ type: "okf", title: `OKF 导出存在 ${okfStatus.latest.unresolved_link_count} 个未解析链接`, severity: "medium", score: 50, actionId: "okf-export" });
		}
		const deduplicated = new Map<string, KnowledgeGap>();
		for (const gap of candidates) {
			const id = gap.id || this.makeGapId(gap.type, gap.title);
			const normalized = {
				source: gap.source || gap.type,
				evidence: Array.isArray(gap.evidence) ? [...new Set(gap.evidence)] : [],
				status: "open",
				...gap,
				id,
			};
			const existing = deduplicated.get(id);
			if (!existing || Number(normalized.score || 0) > Number(existing.score || 0)) {
				deduplicated.set(id, normalized);
			}
		}
		return [...deduplicated.values()]
			.sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
			.slice(0, 8);
	}

	normalizeGapKey(value: unknown): string {
		return String(value || "")
			.toLowerCase()
			.replace(/\[\[|\]\]/g, "")
			.replace(/[^\p{L}\p{N}]+/gu, "");
	}

	makeGapId(type: string, value: unknown): string {
		const input = `${type}:${this.normalizeGapKey(value)}`;
		let hash = 2166136261;
		for (let index = 0; index < input.length; index += 1) {
			hash ^= input.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		return `${type}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
	}

	methodHubExists(records: VaultRecord[], title: string): boolean {
		const candidate = this.normalizeGapKey(title);
		if (!candidate) return false;
		return records.some((record) => {
			if (record.type !== "method" && !record.path.startsWith("wiki/methods/")) return false;
			const values = [
				record.name,
				record.frontmatter.title,
				record.frontmatter.title_zh,
				...(Array.isArray(record.frontmatter.aliases) ? record.frontmatter.aliases : []),
			];
			return values.some((value) => {
				const key = this.normalizeGapKey(value);
				return key && (key === candidate || (key.length >= 6 && candidate.includes(key)));
			});
		});
	}

	computeInboundReferenceCounts(records: VaultRecord[]): Map<string, number> {
		const counts = new Map<string, number>();
		for (const record of records) {
			for (const match of record.text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
				const target = normalizePath(match[1]).replace(/\.md$/i, "");
				for (const candidate of records) {
					const candidatePath = candidate.path.replace(/\.md$/i, "");
					if (target === candidatePath || target === candidate.name) {
						counts.set(candidate.path, (counts.get(candidate.path) || 0) + 1);
						break;
					}
				}
			}
		}
		return counts;
	}

	paperGapScore(record: VaultRecord, inboundCount: number): number {
		const status = String(record.frontmatter.status || "").toLowerCase();
		const depth = String(record.frontmatter.analysis_depth || "").toLowerCase();
		const depthScore = status === "abstract-level" || depth === "abstract-level" ? 70 : 55;
		const missingEvidence = ["source_path", "converted_path", "doi"]
			.filter((key) => !String(record.frontmatter[key] || "").trim())
			.length;
		return depthScore + Math.min(20, inboundCount * 4) + missingEvidence * 3;
	}

	buildMethodGapInput(title: string): string {
		return [
			`处理知识缺口：创建或更新“${title}”方法页。`,
			"请使用 research-vault-synthesis 检查现有 source note、代码笔记、方法页和索引，基于已有证据建立规范的方法枢纽。",
			"关联相关文献与代码页面，区分 vault 证据、一般背景和未解决缺口；同步更新研究方法索引与日志。",
		].join("\n");
	}

	buildPaperGapInput(record: VaultRecord, title: unknown): string {
		return [
			`处理知识缺口：对“${title}”执行全文 x-ray 深读。`,
			`Source note：knowledge-base/${record.path}`,
			"请定位对应 PDF 或全文，检查方法、图表、数据/材料、关键结论、局限性和证据链。只有完成全文证据检查后才能升级为 x-ray；若全文不可用，请记录证据缺口并保持当前深度。",
		].join("\n");
	}

	computeCoverage(
		methodRecords: VaultRecord[],
		synthesisRecords: VaultRecord[],
		knowledgeGaps: KnowledgeGap[],
	): Coverage {
		const recentHubs = [...methodRecords, ...synthesisRecords]
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, 4)
			.map((record) => String(record.frontmatter.title || record.name));
		const missingMethodPages = knowledgeGaps.filter((gap) => gap.type === "method").length;
		return {
			methodNodes: methodRecords.length,
			synthesisNodes: synthesisRecords.length,
			missingMethodPages,
			recentHubs,
		};
	}

	computeOkfReadiness(
		records: VaultRecord[],
		linkReport: LinkReport,
		missingFrontmatter: number,
		coverage: Coverage,
	) {
		const wikiRecords = records.filter((record) => record.path.startsWith("wiki/") && !record.path.endsWith("index.md") && !record.path.endsWith("log.md"));
		const typedRecords = wikiRecords.filter((record) => Boolean(record.frontmatter.type));
		const typePercent = wikiRecords.length === 0 ? 100 : Math.round((typedRecords.length / wikiRecords.length) * 100);
		const hasWikiIndex = records.some((record) => record.path === "wiki/index.md");
		const hasWikiLog = records.some((record) => record.path === "wiki/log.md");
		const hasWikilinks = linkReport.total > 0;
		const exportStatus = this.plugin.getOkfExportStatus();
		const latest = exportStatus.latest;
		return {
			readiness: [
				{
					label: `源 type 覆盖 ${typePercent}%${typePercent < 100 ? "，导出时补齐" : ""}`,
					state: exportStatus.exporterAvailable ? "ready" : "pending",
				},
				{
					label: hasWikiIndex && hasWikiLog ? "index/log 生成规则就绪" : "导出时生成 index/log",
					state: exportStatus.exporterAvailable ? "ready" : "pending",
				},
				{
					label: hasWikilinks ? "wikilink 转换已接入" : "无需转换 wikilink",
					state: exportStatus.exporterAvailable ? "ready" : "pending",
				},
				{
					label: latest ? `最近 bundle：${latest.concept_count || 0} 个概念` : "尚无导出 bundle",
					state: latest && latest.conformant ? "ready" : "pending",
				},
			],
			latestLabel: latest ? `最近导出 ${this.formatExportTime(latest.generated_at)}` : exportStatus.error ? "导出状态不可读" : "尚未导出",
			maintenanceRisk: {
				level: linkReport.broken.length > 0 || missingFrontmatter > 0 ? "watch" : "low",
				items: [
					`${linkReport.broken.length} 个内部断链`,
					`${coverage.missingMethodPages} 个方法枢纽候选`,
					`${missingFrontmatter} 个 wiki 笔记缺失属性区`,
				],
			},
		};
	}

	formatExportTime(value: unknown): string {
		const date = new Date(String(value || ""));
		if (Number.isNaN(date.getTime())) return "时间未知";
		return new Intl.DateTimeFormat("zh-CN", {
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(date);
	}

	computeLinkReport(records: VaultRecord[]): LinkReport {
		const knownPaths = new Set();
		const knownBasenames = new Set();
		for (const record of records) {
			const withoutExt = record.path.replace(/\.md$/i, "");
			knownPaths.add(withoutExt);
			knownBasenames.add(record.name);
		}
		const broken: LinkReport["broken"] = [];
		let total = 0;
		for (const record of records) {
			if (!record.path.startsWith("wiki/") && !record.path.includes("索引")) {
				continue;
			}
			const text = this.stripCode(record.text);
			for (const match of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
				total += 1;
				const link = match[1].trim();
				if (!link) continue;
				const target = link.endsWith(".md") ? link.slice(0, -3) : link;
				const candidates = [
					normalizePath(target),
					normalizePath(`wiki/${target}`),
				];
				if (!candidates.some((candidate) => knownPaths.has(candidate)) && !knownBasenames.has(target)) {
					broken.push({ source: record.path, target });
				}
			}
		}
		return { total, broken };
	}

	stripCode(text: string): string {
		return text
			.replace(/^(```+|~~~+)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "")
			.replace(/`[^`\n]*`/g, "");
	}

	formatTime(date: Date): string {
		return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	}

	formatMonthYear(date: Date): string {
		return new Intl.DateTimeFormat("zh-CN", { month: "short", year: "numeric" }).format(date);
	}

	addDays(date: Date, count: number): Date {
		const next = new Date(date);
		next.setDate(next.getDate() + count);
		return next;
	}

	mondayStart(date: Date): Date {
		const next = new Date(date);
		const day = next.getDay();
		const offset = day === 0 ? -6 : 1 - day;
		next.setDate(next.getDate() + offset);
		return next;
	}

	sundayEnd(date: Date): Date {
		const next = new Date(date);
		const day = next.getDay();
		const offset = day === 0 ? 0 : 7 - day;
		next.setDate(next.getDate() + offset);
		return next;
	}

	toISODate(date: Date): string {
		const year = String(date.getFullYear());
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}
}
