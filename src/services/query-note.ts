import type { App } from "obsidian";

const MAX_FILENAME_LENGTH = 80;
const DEFAULT_QUERY_NOTES_FOLDER = "wiki/qa";

export interface QueryNoteInput {
	folder: string;
	question: string;
	answer: string;
	sources: string[];
	sessionTitle: string;
	createdAt?: string;
}

export function sanitizeQueryNoteFilename(raw: string): string {
	const cleaned = String(raw || "")
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_FILENAME_LENGTH)
		.replace(/^[\s.-]+|[\s.-]+$/g, "");
	return cleaned || "未命名问答";
}

function dateStamp(value?: string): string {
	const date = value ? new Date(value) : new Date();
	const valid = Number.isNaN(date.getTime()) ? new Date() : date;
	const pad = (input: number): string => String(input).padStart(2, "0");
	return `${valid.getFullYear()}${pad(valid.getMonth() + 1)}${pad(valid.getDate())}-${pad(valid.getHours())}${pad(valid.getMinutes())}`;
}

async function ensureFolder(
	vault: App["vault"],
	folderPath: string,
): Promise<void> {
	const segments = folderPath.split("/").filter(Boolean);
	let current = "";
	for (const segment of segments) {
		current = current ? `${current}/${segment}` : segment;
		if (vault.getAbstractFileByPath(current)) continue;
		try {
			await vault.createFolder(current);
		} catch {
			// Creation race: a later segment lookup re-checks existence.
		}
	}
}

/**
 * Saves one query answer as a Markdown note. This is the minimal form of the
 * shared note-writing pipeline (annotation explanations and Q&A notes both
 * produce frontmatter-annotated, source-linked notes into a configurable
 * folder); topic merging and index pages arrive with the full pipeline.
 */
export async function saveQueryAnswerNote(app: App, input: QueryNoteInput): Promise<string> {
	const vault = app?.vault;
	if (!vault || typeof vault.create !== "function") {
		throw new Error("当前 Vault 不可写");
	}
	const folder = String(input.folder || "").trim()
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "") || DEFAULT_QUERY_NOTES_FOLDER;
	if (folder.split("/").includes("..")) {
		throw new Error("笔记目录不能超出当前 Vault");
	}
	await ensureFolder(vault, folder);
	const title = sanitizeQueryNoteFilename(input.question || input.sessionTitle);
	let filePath = `${folder}/${dateStamp(input.createdAt)} ${title}.md`;
	let counter = 2;
	while (vault.getAbstractFileByPath(filePath)) {
		filePath = `${folder}/${dateStamp(input.createdAt)} ${title} ${counter}.md`;
		counter += 1;
	}
	const created = (() => {
		const parsed = input.createdAt ? new Date(input.createdAt) : new Date();
		return (Number.isNaN(parsed.getTime()) ? new Date() : parsed).toISOString();
	})();
	const sourceLinks = (Array.isArray(input.sources) ? input.sources : [])
		.map((source) => String(source || "").trim().replace(/\.md$/i, ""))
		.filter(Boolean).length
		? [...new Set((input.sources || [])
			.map((source) => String(source || "").trim().replace(/\.md$/i, ""))
			.filter(Boolean))]
			.map((source) => `- [[${source}]]`).join("\n")
		: "- 无";
	const frontmatter = [
		"---",
		`title: ${JSON.stringify(title)}`,
		`created: ${created}`,
		"type: qa",
		"tags:",
		"  - qa",
		`source: ${JSON.stringify(String(input.sessionTitle || "").trim().slice(0, 120) || "知识库对话")}`,
		"---",
		"",
	].join("\n");
	const body = [
		`# ${String(input.question || "").trim().slice(0, 500) || "知识库问答"}`,
		"",
		`${String(input.answer || "").trim()}`,
		"",
		"## 来源",
		sourceLinks,
		"",
	].join("\n");
	await vault.create(filePath, frontmatter + body);
	return filePath;
}
