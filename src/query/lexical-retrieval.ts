import { TFile, type App } from "obsidian";

const MAX_INDEX_FILES = 5000;
const MAX_INDEX_BODY_CHARS = 24_000;
const MAX_INDEX_TIME_BUDGET_MS = 2_000;
const MAX_CANDIDATE_PATHS = 10;
// Token budgets are per purpose: a long body must not be truncated to the
// query-side budget, and expansion terms keep a reserved quota so a long
// question cannot push LLM-generated keywords out of the query.
const QUERY_TOKEN_LIMIT = 24;
const EXPANSION_TOKEN_LIMIT = 8;
const MAX_QUERY_TERMS = 24;
const TITLE_TOKEN_LIMIT = 128;
const TAG_TOKEN_LIMIT = 256;
const BODY_TOKEN_LIMIT = 2_000;
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

export interface LexicalRetrieverOptions {
	now?: () => number;
}

/**
 * Deterministic lexical tokenization shared by query and index side. Latin
 * words keep their separator characters trimmed, CJK runs become character
 * bigrams so Chinese titles and bodies match without a segmenter. `maxTokens`
 * bounds the result per use: queries pass QUERY_TOKEN_LIMIT, index fields pass
 * their own limits (or Infinity to keep everything).
 */
export function tokenizeForLexicalRetrieval(
	input: string,
	maxTokens: number = QUERY_TOKEN_LIMIT,
): string[] {
	const text = String(input || "").normalize("NFKC").toLowerCase();
	const tokens = new Set<string>();
	// Split Han runs away before extracting other Unicode word tokens so mixed
	// scientific text such as `p53基因` keeps both `p53` and the Han bigrams.
	const nonHanText = text.replace(/\p{Script=Han}+/gu, " ");
	for (const match of nonHanText.matchAll(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}+#._-]{1,}/gu)) {
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
	return Number.isFinite(maxTokens) ? [...tokens].slice(0, maxTokens) : [...tokens];
}

function addTokens(target: Set<string>, text: string, maxTokens: number): void {
	for (const token of tokenizeForLexicalRetrieval(text, maxTokens)) target.add(token);
}

/**
 * In-plugin retrieval fallback for Direct API vault queries when the optional
 * Research Vault Toolkit (Python `retrieve_vault.py`) is unavailable. Scoring
 * is title > tags > body so a fallback answer still reaches the same
 * candidate-path contract as the toolkit retriever: `lexical_seeds` carries
 * matched page objects ({ path, title, score }), `lexical_terms` carries the
 * plain query tokens.
 */
export class LexicalVaultRetriever {
	private readonly app: App;
	private readonly now: () => number;
	private readonly documents = new Map<string, LexicalDocument>();

	constructor(app: App, options: LexicalRetrieverOptions = {}) {
		this.app = app;
		this.now = options.now || Date.now;
	}

	async retrieve(
		question: string,
		expandedTerms: string[] = [],
		options: { allowedPrefixes?: string[] } = {},
	): Promise<Record<string, unknown>> {
		const allowedPrefixes = (options.allowedPrefixes || [])
			.map((prefix) => String(prefix || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
			.filter(Boolean);
		const scopedIndex = allowedPrefixes.length
			? await this.buildScopedIndex(allowedPrefixes)
			: null;
		if (!scopedIndex) await this.refreshIndex();
		const documents = scopedIndex?.documents || this.documents;
		const withinScope = (filePath: string): boolean => {
			if (!allowedPrefixes.length) return true;
			return allowedPrefixes.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`));
		};
		const questionTerms = tokenizeForLexicalRetrieval(question, QUERY_TOKEN_LIMIT);
		const expansionTerms = tokenizeForLexicalRetrieval(
			expandedTerms.join(" "),
			EXPANSION_TOKEN_LIMIT,
		);
		const terms = [...new Set([...expansionTerms, ...questionTerms])]
			.slice(0, MAX_QUERY_TERMS);
		const phrase = String(question || "").trim().toLowerCase().slice(0, 60);
		const scored: Array<{ path: string; score: number; mtime: number }> = [];
		for (const [filePath, document] of documents) {
			if (!withinScope(filePath)) continue;
			let score = 0;
			let reinforced = false;
			let latinBodyHit = false;
			for (const term of terms) {
				if (document.titleTokens.has(term)) {
					score += TITLE_SCORE;
					reinforced = true;
				}
				if (document.tagTokens.has(term)) {
					score += TAG_SCORE;
					reinforced = true;
				}
				if (document.bodyTokens.has(term)) {
					score += BODY_SCORE;
					if (/^[a-z0-9]/.test(term)) latinBodyHit = true;
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
		const top = scored.slice(0, MAX_CANDIDATE_PATHS);
		return {
			stage: "in-plugin-lexical",
			retrieval_label: "内置词法检索",
			lexical_terms: terms,
			lexical_seeds: top.map((item) => ({
				path: item.path,
				title: documents.get(item.path)?.title
					|| item.path.replace(/\.md$/i, ""),
				score: item.score,
			})),
			candidate_paths: top.map((item) => item.path),
			graph_expansion: [],
			engine: "in-plugin-lexical",
			retriever: { selected: "in-plugin-lexical" },
			indexed_files: documents.size,
			scope_complete: scopedIndex?.complete ?? true,
			scope_total_files: scopedIndex?.totalFiles ?? documents.size,
		};
	}

	private eligibleMarkdownFiles(): TFile[] {
		const vault = this.app?.vault;
		if (!vault || typeof vault.getMarkdownFiles !== "function") return [];
		return vault.getMarkdownFiles()
			.filter((file): file is TFile => file instanceof TFile
				&& !String(file.path || "").startsWith(".")
				&& String(file.path || "").toLowerCase().endsWith(".md"));
	}

	private sortByFreshness(files: TFile[]): TFile[] {
		return files.sort((a, b) => (
			(Number(b.stat?.mtime) || 0) - (Number(a.stat?.mtime) || 0)
			|| String(a.path).localeCompare(String(b.path))
		));
	}

	/**
	 * Identity/dedup searches use an isolated, scope-first index. This keeps
	 * 5,000 newer unrelated Vault notes from evicting an older source note,
	 * without mutating the shared full-Vault query cache. If the allowed scope
	 * itself exceeds the bound, callers receive an explicit incomplete marker
	 * and the ingest tool fails closed instead of accepting duplicateStatus=none.
	 */
	private async buildScopedIndex(
		allowedPrefixes: readonly string[],
	): Promise<{ documents: Map<string, LexicalDocument>; complete: boolean; totalFiles: number }> {
		const files = this.sortByFreshness(this.eligibleMarkdownFiles().filter((file) => {
			const filePath = String(file.path || "").replace(/\\/g, "/");
			return allowedPrefixes.some((prefix) => (
				filePath === prefix || filePath.startsWith(`${prefix}/`)
			));
		}));
		if (files.length > MAX_INDEX_FILES) {
			return { documents: new Map(), complete: false, totalFiles: files.length };
		}
		const documents = new Map<string, LexicalDocument>();
		await this.indexFiles(files, documents);
		return { documents, complete: true, totalFiles: files.length };
	}

	private async refreshIndex(): Promise<void> {
		const files = this.sortByFreshness(this.eligibleMarkdownFiles())
			.slice(0, MAX_INDEX_FILES);
		const livePaths = new Set(files.map((file) => String(file.path)));
		for (const existingPath of [...this.documents.keys()]) {
			if (!livePaths.has(existingPath)) this.documents.delete(existingPath);
		}
		await this.indexFiles(files, this.documents);
	}

	private async indexFiles(
		files: readonly TFile[],
		documents: Map<string, LexicalDocument>,
	): Promise<void> {
		const vault = this.app?.vault;
		if (!vault) return;
		const deadline = this.now() + MAX_INDEX_TIME_BUDGET_MS;
		for (const file of files) {
			const filePath = String(file.path);
			const mtime = Number(file.stat?.mtime) || 0;
			const cached = documents.get(filePath);
			// Entries whose body was never indexed (the time budget ran out on a
			// previous pass) must be retried instead of being skipped forever.
			if (cached && cached.mtime === mtime && cached.bodyIndexed) continue;
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
			addTokens(document.titleTokens, `${file.basename || ""} ${metadata.title}`, TITLE_TOKEN_LIMIT);
			for (const tag of metadata.tags) addTokens(document.tagTokens, tag, TAG_TOKEN_LIMIT);
			if (this.now() <= deadline) {
				try {
					const raw = await vault.cachedRead(file);
					addTokens(document.bodyTokens, String(raw || "").slice(0, MAX_INDEX_BODY_CHARS), BODY_TOKEN_LIMIT);
					document.bodyIndexed = true;
				} catch {
					// Unreadable file: keep the metadata-only entry and retry the
					// body on a later refresh instead of marking it done.
					document.bodyIndexed = false;
				}
			}
			documents.set(filePath, document);
		}
	}

	private readDocumentMetadata(file: TFile): { title: string; tags: string[] } {
		const title = String(file.basename || "").trim();
		const tags: string[] = [];
		try {
			const cache = this.app?.metadataCache?.getFileCache?.(file);
			const frontmatter = cache?.frontmatter as Record<string, unknown> | undefined;
			const frontmatterTitle = String(frontmatter?.title || "").trim();
			const firstH1 = Array.isArray(cache?.headings)
				? String(cache.headings.find((heading) => Number(heading?.level) === 1)?.heading || "").trim()
				: "";
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
			// The basename is indexed separately by refreshIndex. Expose the
			// canonical frontmatter title to callers so a search receipt can bind a
			// candidate to the paper identity instead of returning
			// "<citekey> <paper title>" as one synthetic title.
			return { title: frontmatterTitle || firstH1 || title, tags };
		} catch {
			return { title, tags };
		}
	}
}
