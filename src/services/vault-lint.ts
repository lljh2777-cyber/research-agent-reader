import { normalizePath, type App, type TFile } from "obsidian";

import type {
	DashboardProcessHooks,
	DashboardProcessResult,
	LintFinding,
	LintReport,
} from "../types/contracts";

const PRIMARY_ROOTS = ["papers", "wiki", "Clippings"] as const;
const EXCLUDED_HEALTH_ROOTS = ["papers", "Clippings"] as const;
const RESERVED_WIKI_NAMES = new Set(["index.md", "log.md", "readme.md"]);
const ORPHAN_TYPES = new Set([
	"source",
	"concept",
	"method",
	"dataset",
	"project",
	"moc",
	"synthesis",
	"code-project",
	"code-script",
]);
const WIKI_CONTENT_ROOTS = new Set([
	"annotations",
	"code",
	"concepts",
	"datasets",
	"entities",
	"linux",
	"methods",
	"mocs",
	"projects",
	"r",
	"sources",
	"synthesis",
]);

interface LintNote {
	file: TFile;
	path: string;
	text: string;
	type: string;
}

function normalizeVaultPath(value: string): string {
	return normalizePath(String(value || "").replace(/\\/g, "/").replace(/^\/+/, ""));
}

function primaryRoot(value: string): string {
	const first = normalizeVaultPath(value).split("/", 1)[0];
	return PRIMARY_ROOTS.find((root) => root.toLowerCase() === first.toLowerCase()) || "";
}

function isTopLevelMarkdown(value: string): boolean {
	const normalized = normalizeVaultPath(value);
	return normalized.toLowerCase().endsWith(".md") && !normalized.includes("/");
}

export function isVaultHealthScopePath(value: string): boolean {
	const normalized = normalizeVaultPath(value);
	return normalized.toLowerCase().startsWith("wiki/") || isTopLevelMarkdown(normalized);
}

export function isExcludedVaultHealthPath(value: string): boolean {
	const root = primaryRoot(value);
	return EXCLUDED_HEALTH_ROOTS.some((excluded) => excluded.toLowerCase() === root.toLowerCase());
}

function stripCode(text: string): string {
	return text
		.replace(/<!--[^]*?-->/g, "")
		.replace(/^(```+|~~~+)[^\n]*\n[^]*?^\1[ \t]*$/gm, "")
		.replace(/`[^`\n]*`/g, "");
}

function extractWikilinks(text: string): string[] {
	return [...stripCode(text).matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
		.map((match) => match[1].trim())
		.filter(Boolean);
}

function extractMarkdownLinks(text: string): string[] {
	return [...stripCode(text).matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)]
		.map((match) => match[1].trim())
		.filter(Boolean);
}

function cleanMarkdownTarget(value: string): string {
	let target = String(value || "").trim();
	if (target.startsWith("<") && target.includes(">")) {
		target = target.slice(1, target.indexOf(">"));
	} else {
		target = target.split(/\s+["']/u, 1)[0];
	}
	try {
		target = decodeURIComponent(target);
	} catch {
		// Malformed percent encoding is kept so it can still be reported.
	}
	return target.split("#", 1)[0].split("?", 1)[0].trim();
}

function hasExternalScheme(value: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);
}

function normalizeLinkTarget(rawTarget: string, sourcePath: string, wikilink: boolean): string {
	let target = wikilink ? rawTarget.trim() : cleanMarkdownTarget(rawTarget);
	if (!target || target.startsWith("#") || hasExternalScheme(target)) return "";
	target = target.replace(/\\/g, "/").replace(/^\/+/, "");
	target = target.replace(/^knowledge-base\//i, "");
	const explicitRoot = primaryRoot(target);
	if (explicitRoot) return normalizeVaultPath(target);

	const first = target.split("/", 1)[0].toLowerCase();
	if (WIKI_CONTENT_ROOTS.has(first)) return normalizeVaultPath(`wiki/${target}`);
	if (target.startsWith("./") || target.startsWith("../") || (!wikilink && target.includes("/"))) {
		const sourceFolder = sourcePath.includes("/")
			? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
			: "";
		return normalizeVaultPath(resolvePosixPath(sourceFolder, target));
	}
	return normalizeVaultPath(target);
}

function resolvePosixPath(base: string, target: string): string {
	const segments: string[] = [];
	for (const segment of `${base}/${target}`.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.join("/");
}

function withoutMarkdownExtension(value: string): string {
	return normalizeVaultPath(value).replace(/\.md$/i, "");
}

function parseFrontmatterType(text: string): string {
	if (!text.startsWith("---")) return "";
	const match = /^---\s*\r?\n([^]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) return "";
	return /^type:\s*["']?([^\r\n"']+)/mi.exec(match[1])?.[1].trim() || "";
}

function hasFrontmatter(text: string): boolean {
	return /^---\s*\r?\n[^]*?\r?\n---(?:\r?\n|$)/.test(text);
}

function formatFinding(finding: LintFinding): string {
	const severity = finding.severity === "error"
		? "错误"
		: finding.severity === "warning"
			? "警告"
			: "信息";
	return `- [${severity}] ${finding.path || "Vault"}: ${finding.message}`;
}

function makeReport(findings: LintFinding[], stats: Record<string, unknown>): LintReport {
	const errors = findings.filter((finding) => finding.severity === "error").length;
	const warnings = findings.filter((finding) => finding.severity === "warning").length;
	const info = findings.filter((finding) => finding.severity === "info").length;
	return {
		generated_at: new Date().toISOString(),
		summary: {
			score: Math.max(0, 100 - errors * 10 - warnings * 2),
			errors,
			warnings,
			info,
		},
		findings,
		stats,
		scope: {
			included: ["wiki/", "Vault 顶层 Markdown"],
			excluded: ["papers/", "Clippings/"],
			boundary_only: ["papers/", "Clippings/"],
		},
	};
}

export class VaultLintService {
	constructor(private readonly app: App) {}

	async run(hooks: DashboardProcessHooks = {}): Promise<{ report: LintReport; result: DashboardProcessResult }> {
		hooks.onEvent?.({ type: "status", stage: "vault-lint", status: "running", label: "读取知识库" });
		const allFiles = this.app.vault.getMarkdownFiles();
		const scopedFiles = allFiles.filter((file) => isVaultHealthScopePath(file.path));
		const boundaryFiles = allFiles.filter((file) => isExcludedVaultHealthPath(file.path));
		const notes = await Promise.all(scopedFiles.map((file) => this.readNote(file)));
		const boundaryNotes = await Promise.all(boundaryFiles.map((file) => this.readNote(file)));
		const findings: LintFinding[] = [];
		const findingKeys = new Set<string>();
		const addFinding = (finding: LintFinding): void => {
			const key = `${finding.severity}\u0000${finding.code}\u0000${finding.path}\u0000${finding.message}`;
			if (findingKeys.has(key)) return;
			findingKeys.add(key);
			findings.push(finding);
		};

		const allPaths = new Set(allFiles.map((file) => withoutMarkdownExtension(file.path).toLowerCase()));
		const scopedPaths = new Set(notes.map((note) => withoutMarkdownExtension(note.path).toLowerCase()));
		const basenameMap = new Map<string, string[]>();
		for (const note of notes) {
			const basename = note.file.basename.toLowerCase();
			basenameMap.set(basename, [...(basenameMap.get(basename) || []), note.path]);
		}
		const incoming = new Map<string, number>();

		for (const note of notes) {
			if (
				note.path.toLowerCase().startsWith("wiki/")
				&& !RESERVED_WIKI_NAMES.has(note.file.name.toLowerCase())
				&& !hasFrontmatter(note.text)
			) {
				addFinding({
					severity: "warning",
					category: "frontmatter",
					code: "missing-frontmatter",
					path: note.path,
					message: "Wiki 笔记缺少 YAML 属性区。",
					fixable: true,
				});
			}
			this.checkLinks(note, allPaths, scopedPaths, basenameMap, incoming, addFinding, true);
		}

		for (const note of boundaryNotes) {
			this.checkBoundaryLinks(note, addFinding);
		}

		for (const note of notes) {
			if (!note.path.toLowerCase().startsWith("wiki/")) continue;
			if (RESERVED_WIKI_NAMES.has(note.file.name.toLowerCase())) continue;
			if (!ORPHAN_TYPES.has(note.type.toLowerCase())) continue;
			if ((incoming.get(withoutMarkdownExtension(note.path).toLowerCase()) || 0) > 0) continue;
			addFinding({
				severity: "warning",
				category: "orphans",
				code: "orphan-note",
				path: note.path,
				message: "在 wiki/ 与顶层索引范围内未找到指向该笔记的 wikilink。",
				fixable: true,
			});
		}

		findings.sort((left, right) => {
			const severityOrder = { error: 0, warning: 1, info: 2 } as const;
			return severityOrder[left.severity] - severityOrder[right.severity]
				|| left.path.localeCompare(right.path)
				|| left.code.localeCompare(right.code);
		});
		const report = makeReport(findings, {
			markdown_count: scopedFiles.length,
			wiki_markdown_count: scopedFiles.filter((file) => normalizeVaultPath(file.path).toLowerCase().startsWith("wiki/")).length,
			top_level_markdown_count: scopedFiles.filter((file) => isTopLevelMarkdown(file.path)).length,
			boundary_file_count: boundaryFiles.length,
			excluded_knowledge_roots: [...EXCLUDED_HEALTH_ROOTS],
		});
		const summary = report.summary || {};
		const outputLines = [
			`Vault lint: score ${summary.score ?? 0} · ${summary.errors ?? 0} error(s) · ${summary.warnings ?? 0} warning(s)`,
			"体检范围：wiki/ 与 Vault 顶层 Markdown。",
			"排除范围：papers/、Clippings/ 不参与断链、孤立页、属性与内容检查；仅检查三主目录之间的跨根链接。",
			...(findings.length ? ["", "发现：", ...findings.map(formatFinding)] : ["", "未发现待处理项。"]),
		];
		const stdout = outputLines.join("\n");
		hooks.onStdout?.(stdout);
		hooks.onEvent?.({
			type: "status",
			stage: "vault-lint",
			status: "done",
			label: findings.length ? "体检完成，发现待处理项" : "体检完成",
			payload: { summary: report.summary || {} },
		});
		return {
			report,
			result: {
				exitCode: findings.length ? 1 : 0,
				signal: "",
				stdout,
				stderr: "",
				events: [],
			},
		};
	}

	private async readNote(file: TFile): Promise<LintNote> {
		const text = await this.app.vault.cachedRead(file);
		return {
			file,
			path: normalizeVaultPath(file.path),
			text,
			type: parseFrontmatterType(text),
		};
	}

	private checkLinks(
		note: LintNote,
		allPaths: Set<string>,
		scopedPaths: Set<string>,
		basenameMap: Map<string, string[]>,
		incoming: Map<string, number>,
		addFinding: (finding: LintFinding) => void,
		includeBroken: boolean,
	): void {
		for (const rawLink of extractWikilinks(note.text)) {
			const target = this.resolveWikilinkTarget(
				rawLink,
				note.path,
				normalizeLinkTarget(rawLink, note.path, true),
			);
			if (!target) continue;
			if (this.addCrossRootFinding(note.path, rawLink, target, addFinding)) continue;
			const resolved = this.resolveScopedTarget(target, scopedPaths, basenameMap);
			if (resolved) {
				if (resolved !== note.path.toLowerCase()) {
					incoming.set(resolved, (incoming.get(resolved) || 0) + 1);
				}
				continue;
			}
			if (includeBroken && !allPaths.has(withoutMarkdownExtension(target).toLowerCase())) {
				addFinding({
					severity: "error",
					category: "links",
					code: "missing-wikilink-target",
					path: note.path,
					message: `找不到 wikilink 目标 \`${rawLink}\`。`,
				});
			}
		}
		for (const rawLink of extractMarkdownLinks(note.text)) {
			const target = normalizeLinkTarget(rawLink, note.path, false);
			if (target) this.addCrossRootFinding(note.path, rawLink, target, addFinding);
		}
	}

	private checkBoundaryLinks(
		note: LintNote,
		addFinding: (finding: LintFinding) => void,
	): void {
		for (const rawLink of extractWikilinks(note.text)) {
			const target = this.resolveWikilinkTarget(
				rawLink,
				note.path,
				normalizeLinkTarget(rawLink, note.path, true),
			);
			if (target) this.addCrossRootFinding(note.path, rawLink, target, addFinding);
		}
		for (const rawLink of extractMarkdownLinks(note.text)) {
			const target = normalizeLinkTarget(rawLink, note.path, false);
			if (target) this.addCrossRootFinding(note.path, rawLink, target, addFinding);
		}
	}

	private addCrossRootFinding(
		sourcePath: string,
		rawLink: string,
		targetPath: string,
		addFinding: (finding: LintFinding) => void,
	): boolean {
		const sourceRoot = primaryRoot(sourcePath);
		const targetRoot = primaryRoot(targetPath);
		if (!sourceRoot || !targetRoot || sourceRoot.toLowerCase() === targetRoot.toLowerCase()) return false;
		addFinding({
			severity: "error",
			category: "links",
			code: "cross-root-link",
			path: sourcePath,
			message: `禁止从 ${sourceRoot}/ 链接到 ${targetRoot}/：\`${rawLink}\`。如需记录来源位置，请改用行内代码路径。`,
			fixable: true,
		});
		return true;
	}

	private resolveWikilinkTarget(rawLink: string, sourcePath: string, fallback: string): string {
		const resolver = this.app.metadataCache?.getFirstLinkpathDest;
		if (typeof resolver !== "function") return fallback;
		const resolved = resolver.call(this.app.metadataCache, rawLink, sourcePath);
		return resolved?.path ? normalizeVaultPath(resolved.path) : fallback;
	}

	private resolveScopedTarget(
		target: string,
		scopedPaths: Set<string>,
		basenameMap: Map<string, string[]>,
	): string {
		const normalized = withoutMarkdownExtension(target).toLowerCase();
		const candidates = [normalized];
		if (!normalized.startsWith("wiki/")) candidates.push(`wiki/${normalized}`);
		for (const candidate of candidates) {
			if (scopedPaths.has(candidate)) return candidate;
		}
		const basename = normalized.split("/").pop() || "";
		const matches = basenameMap.get(basename) || [];
		return matches.length === 1 ? withoutMarkdownExtension(matches[0]).toLowerCase() : "";
	}
}
