import { TFile, type App } from "obsidian";

const MAX_INDEX_FILES = 5000;
const MAX_INDEX_BODY_CHARS = 24_000;
const MAX_INDEX_TIME_BUDGET_MS = 2_000;
const MAX_CANDIDATE_PATHS = 10;
const MAX_QUERY_SEEDS = 12;
const MIN_CANDIDATE_SCORE = 2;
const STRONG_CANDIDATE_SCORE = 4;
const TITLE_SCORE = 6;
const TAG_SCORE = 4;
const BODY_SCORE = 2;
const PHRASE_SCORE = 8;

interface LexicalDocument {
	mtime: number;
	title: string;
	titleTokens: Set<string>;
	tagTokens: Set<string>;
	bodyTokens: Set<string>;
	bodyIndexed: boolean;
}

/**
 * Deterministic lexical tokenization shared by query and index side. Latin
 * words keep their separator characters trimmed, CJK runs become character
 * bigrams so Chinese titles and bodies match without a segmenter.
 */
export function tokenizeForLexicalRetrieval(input: string): string[] {
	const text = String(input || "").toLowerCase();
	const tokens = new Set<string>();
	for (const match of text.matchAll(/[a-z0-9][a-z0-9+#._-]{1,}/g)) {
		const token = match[0].replace(/^[._-]+|[._-]+$/g, "");
		if (token.length >= 2) tokens.add(token);
	}
	for (const match of text.matchAll(/[\u4e00-\u9fff]+/g)) {
		const run = match[0];
		if (run.length === 1) {
			tokens.add(run);
			continue;
		}
		for (let index = 0; index < run.length - 1; index += 1) {
			tokens.add(run.slice(index, index + 2));
		}
	}
	return [...tokens].slice(0, 48);
}

function addTokens(target: Set<string>, text: string): void {
	for (const token of tokenizeForLexicalRetrieval(text)) target.add(token);
}

/**
 * In-plugin retrieval fallback for Direct API vault queries when the optional
 * Research Vault Toolkit (Python `retrieve_vault.py`) is unavailable. Scoring
 * is title > tags > body so a fallback answer still reaches the same
 * candidate-path contract as the toolkit retriever.
 */
export class LexicalVaultRetriever {
	private readonly app: App;
	private readonly documents = new Map<string, LexicalDocument>();

	constructor(app: App) {
		this.app = app;
	}

	async retrieve(
		question: string,
		expandedTerms: string[] = [],
	): Promise<Record<string, unknown>> {
		await this.refreshIndex();
		const seeds = [
			...new Set([
				...tokenizeForLexicalRetrieval(question),
				...expandedTerms.flatMap((term) => tokenizeForLexicalRetrieval(term)),
			]),
		].slice(0, MAX_QUERY_SEEDS);
		const phrase = String(question || "").trim().toLowerCase().slice(0, 60);
		const scored: Array<{ path: string; score: number; mtime: number }> = [];
		for (const [filePath, document] of this.documents) {
			let score = 0;
			let reinforced = false;
			let latinBodyHit = false;
			for (const seed of seeds) {
				if (document.titleTokens.has(seed)) {
					score += TITLE_SCORE;
					reinforced = true;
				}
				if (document.tagTokens.has(seed)) {
					score += TAG_SCORE;
					reinforced = true;
				}
				if (document.bodyTokens.has(seed)) {
					score += BODY_SCORE;
					if (/^[a-z0-9]/.test(seed)) latinBodyHit = true;
				}
			}
			if (
				phrase.length >= 2
				&& document.title.toLowerCase().includes(phrase)
			) {
				score += PHRASE_SCORE;
				reinforced = true;
			}
			// A single CJK bigram body hit is usually an incidental substring
			// collision (e.g. 力学 inside 热力学), so it only qualifies when a
			// second signal reinforces it.
			const qualifies = score >= STRONG_CANDIDATE_SCORE
				|| (score >= MIN_CANDIDATE_SCORE && (reinforced || latinBodyHit));
			if (qualifies) {
				scored.push({ path: filePath, score, mtime: document.mtime });
			}
		}
		scored.sort((a, b) => (
			b.score - a.score
			|| b.mtime - a.mtime
			|| a.path.localeCompare(b.path)
		));
		return {
			stage: "in-plugin-lexical",
			retrieval_label: "内置词法检索",
			lexical_seeds: seeds,
			candidate_paths: scored.slice(0, MAX_CANDIDATE_PATHS).map((item) => item.path),
			graph_expansion: [],
			engine: "in-plugin-lexical",
			indexed_files: this.documents.size,
		};
	}

	private async refreshIndex(): Promise<void> {
		const vault = this.app?.vault;
		if (!vault || typeof vault.getMarkdownFiles !== "function") return;
		const files = vault.getMarkdownFiles()
			.filter((file) => file instanceof TFile
				&& !String(file.path || "").startsWith(".")
				&& String(file.path || "").toLowerCase().endsWith(".md"))
			.sort((a, b) => (
				(Number(b.stat?.mtime) || 0) - (Number(a.stat?.mtime) || 0)
				|| String(a.path).localeCompare(String(b.path))
			))
			.slice(0, MAX_INDEX_FILES);
		const livePaths = new Set(files.map((file) => String(file.path)));
		for (const existingPath of [...this.documents.keys()]) {
			if (!livePaths.has(existingPath)) this.documents.delete(existingPath);
		}
		const deadline = Date.now() + MAX_INDEX_TIME_BUDGET_MS;
		for (const file of files) {
			const filePath = String(file.path);
			const mtime = Number(file.stat?.mtime) || 0;
			const cached = this.documents.get(filePath);
			if (cached && cached.mtime === mtime) continue;
			const document: LexicalDocument = {
				mtime,
				title: "",
				titleTokens: new Set(),
				tagTokens: new Set(),
				bodyTokens: new Set(),
				bodyIndexed: false,
			};
			const metadata = this.readDocumentMetadata(file);
			document.title = metadata.title;
			addTokens(document.titleTokens, `${file.basename || ""} ${metadata.title}`);
			for (const tag of metadata.tags) addTokens(document.tagTokens, tag);
			if (Date.now() <= deadline) {
				try {
					const raw = await vault.cachedRead(file);
					addTokens(document.bodyTokens, String(raw || "").slice(0, MAX_INDEX_BODY_CHARS));
					document.bodyIndexed = true;
				} catch {
					// Unreadable file: keep the metadata-only entry and skip the body.
					document.bodyIndexed = true;
				}
			}
			this.documents.set(filePath, document);
		}
	}

	private readDocumentMetadata(file: TFile): { title: string; tags: string[] } {
		const title = String(file.basename || "").trim();
		const tags: string[] = [];
		try {
			const cache = this.app?.metadataCache?.getFileCache?.(file);
			const frontmatter = cache?.frontmatter as Record<string, unknown> | undefined;
			const frontmatterTitle = String(frontmatter?.title || "").trim();
			const collect = (value: unknown) => {
				if (Array.isArray(value)) {
					value.forEach((item) => tags.push(String(item || "").trim()));
				} else if (typeof value === "string" || typeof value === "number") {
					String(value).split(/[,\s]+/).forEach((item) => tags.push(item.trim()));
				}
			};
			collect(frontmatter?.tags);
			collect(frontmatter?.aliases);
			if (Array.isArray(cache?.tags)) {
				cache.tags.forEach((item) => tags.push(String(item?.tag || "").replace(/^#/, "").trim()));
			}
			return { title: [title, frontmatterTitle].filter(Boolean).join(" "), tags };
		} catch {
			return { title, tags };
		}
	}
}
