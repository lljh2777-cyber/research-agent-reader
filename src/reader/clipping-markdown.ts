import type {
	MineruReaderPackage,
	MineruReaderVisual,
	MineruViewerIndex,
} from "../mineru/types";

interface MarkdownLine {
	text: string;
	start: number;
	end: number;
}

export interface ClippingFigure {
	imageId: string;
	assetPath: string;
	alt: string;
	label: string;
	caption: string;
	captionLines: string[];
}

const MARKDOWN_IMAGE_LINE_RE = /^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)\s*$/i;
const HTML_IMAGE_LINE_RE = /^\s*<img\b([^>]*)>\s*$/i;
const HTML_SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;
const HTML_ALT_RE = /\balt\s*=\s*["']([^"']*)["']/i;

function markdownLines(markdown: string): MarkdownLine[] {
	const lines: MarkdownLine[] = [];
	let start = 0;
	while (start < markdown.length) {
		const newline = markdown.indexOf("\n", start);
		const end = newline < 0 ? markdown.length : newline + 1;
		lines.push({
			text: markdown.slice(start, newline < 0 ? markdown.length : newline).replace(/\r$/, ""),
			start,
			end,
		});
		start = end;
	}
	return lines;
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'");
}

export function readableCaptionText(value: string): string {
	return decodeHtmlEntities(value)
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]+>/g, "")
		.replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1")
		.replace(/(?:\*\*|__|~~|`)(.+?)(?:\*\*|__|~~|`)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function standaloneImage(line: string): { assetPath: string; alt: string } | null {
	const markdownMatch = MARKDOWN_IMAGE_LINE_RE.exec(line);
	if (markdownMatch) {
		return {
			assetPath: decodeHtmlEntities(markdownMatch[2] || markdownMatch[3] || "").trim(),
			alt: decodeHtmlEntities(markdownMatch[1] || "").trim(),
		};
	}
	const htmlMatch = HTML_IMAGE_LINE_RE.exec(line);
	if (!htmlMatch) return null;
	const src = HTML_SRC_RE.exec(htmlMatch[1])?.[1] || "";
	if (!src.trim()) return null;
	return {
		assetPath: decodeHtmlEntities(src).trim(),
		alt: decodeHtmlEntities(HTML_ALT_RE.exec(htmlMatch[1])?.[1] || "").trim(),
	};
}

function looksLikeCaptionLine(value: string): boolean {
	const text = value.trim();
	return Boolean(text)
		&& !/^(?:#{1,6}\s|```|~~~|>|[-+*]\s|\d+[.)]\s|\[\^[^\]]+\]:|---+$|___+$)/.test(text)
		&& !standaloneImage(text);
}

function explicitFigureLabel(value: string): string {
	const normalized = decodeHtmlEntities(value).replace(/[_-]+/g, " ");
	const extended = /\bExtended\s+Data\s+Fig(?:ure)?\.?\s*([A-Za-z]?\d+[A-Za-z]?)\b/i.exec(normalized);
	if (extended) return `Extended Data Fig. ${extended[1]}`;
	const supplementary = /\bSupp(?:lementary)?\s+Fig(?:ure)?\.?\s*([A-Za-z]?\d+[A-Za-z]?)\b/i.exec(normalized);
	if (supplementary) return `Supplementary Fig. ${supplementary[1]}`;
	const ordinary = /\bFig(?:ure)?\.?\s*([A-Za-z]?\d+[A-Za-z]?)\b/i.exec(normalized);
	return ordinary ? `Fig. ${ordinary[1]}` : "";
}

export function figureLabel(
	alt: string,
	assetPath: string,
	caption: string,
	fallbackIndex: number,
): string {
	let decodedAssetPath = assetPath;
	try {
		decodedAssetPath = decodeURIComponent(assetPath);
	} catch {
		// A malformed percent escape must not prevent the rest of the document loading.
	}
	return explicitFigureLabel(alt)
		|| explicitFigureLabel(caption)
		|| explicitFigureLabel(decodedAssetPath)
		|| `Fig. ${fallbackIndex + 1}`;
}

function titleFromMarkdown(markdown: string, articlePath: string): string {
	const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1] || "";
	const titleLine = /^title:\s*(.+?)\s*$/mi.exec(frontmatter)?.[1]?.trim() || "";
	if (titleLine) {
		const unquoted = titleLine.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2").trim();
		if (unquoted) return unquoted.replace(/\\"/g, '"').replace(/''/g, "'");
	}
	const heading = /^#\s+(.+?)\s*$/m.exec(markdown)?.[1]?.trim();
	if (heading) return readableCaptionText(heading);
	const filename = articlePath.split("/").pop() || "Markdown 文献";
	return filename.replace(/\.md$/i, "");
}

function markdownWithoutFrontmatter(markdown: string): string {
	const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	if (!match || !/^[-\w]+:\s*/m.test(match[1])) return markdown;
	return markdown.slice(match[0].length);
}

export function extractClippingFigures(markdown: string): ClippingFigure[] {
	const lines = markdownLines(markdown);
	const figures: ClippingFigure[] = [];
	const usedLabels = new Set<string>();
	for (let index = 0; index < lines.length; index += 1) {
		const image = standaloneImage(lines[index].text);
		if (!image) continue;
		let captionStart = index + 1;
		while (captionStart < lines.length && !lines[captionStart].text.trim()) captionStart += 1;
		const captionLines: string[] = [];
		if (captionStart < lines.length && looksLikeCaptionLine(lines[captionStart].text)) {
			for (let cursor = captionStart; cursor < lines.length; cursor += 1) {
				const text = lines[cursor].text.trim();
				if (!text || !looksLikeCaptionLine(text)) break;
				captionLines.push(text);
			}
		}
		const rawCaption = captionLines.join(" ");
		const altCaption = explicitFigureLabel(image.alt) === readableCaptionText(image.alt)
			? ""
			: readableCaptionText(image.alt);
		const explicitLabel = explicitFigureLabel(image.alt)
			|| explicitFigureLabel(rawCaption)
			|| (() => {
				try {
					return explicitFigureLabel(decodeURIComponent(image.assetPath));
				} catch {
					return explicitFigureLabel(image.assetPath);
				}
			})();
		let label = explicitLabel;
		let fallbackNumber = figures.length + 1;
		while (!label || usedLabels.has(label.toLowerCase())) {
			label = `Fig. ${fallbackNumber}`;
			fallbackNumber += 1;
			if (!usedLabels.has(label.toLowerCase())) break;
		}
		usedLabels.add(label.toLowerCase());
		figures.push({
			imageId: `md-img-${String(figures.length).padStart(4, "0")}`,
			assetPath: image.assetPath,
			alt: image.alt,
			label,
			caption: readableCaptionText(rawCaption) || altCaption,
			captionLines,
		});
	}
	return figures;
}

function clippingVisual(figure: ClippingFigure, index: number): MineruReaderVisual {
	return {
		id: `markdown-visual-${String(index).padStart(4, "0")}`,
		pageIdx: index,
		label: figure.label,
		caption: figure.caption,
		captionParts: figure.caption ? [figure.caption] : [],
		captionSourceBlockIds: [],
		pageRange: [index, index],
		memberBlockIds: [`markdown-image-${String(index).padStart(4, "0")}`],
		memberAssetPaths: [figure.assetPath],
		memberMarkdownImageIds: [figure.imageId],
		samePageCaptionProjections: figure.captionLines.map((text) => ({
			markdownImageId: figure.imageId,
			text,
		})),
		anchorAssetPath: figure.assetPath,
		display: { mode: "asset", assetPath: figure.assetPath },
		repairDecision: "keep-original",
		confidence: 1,
	};
}

export function buildMarkdownReaderPackage(
	articleMarkdown: string,
	articlePath: string,
): MineruReaderPackage {
	const normalizedPath = articlePath.replace(/\\/g, "/").replace(/^\/+/, "");
	const slash = normalizedPath.lastIndexOf("/");
	const packagePath = slash >= 0 ? normalizedPath.slice(0, slash) : "";
	const readingMarkdown = markdownWithoutFrontmatter(articleMarkdown);
	const figures = extractClippingFigures(readingMarkdown);
	const viewerIndex: MineruViewerIndex = {
		schema_version: 1,
		status: "partial",
		markdown_images: figures.map((figure, index) => ({
			id: figure.imageId,
			order: index,
			asset_path: figure.assetPath,
			occurrence: 0,
		})),
		pages: [],
		issues: [],
	};
	return {
		sourceKind: "markdown",
		packagePath,
		articlePath: normalizedPath,
		title: titleFromMarkdown(articleMarkdown, normalizedPath),
		articleMarkdown: readingMarkdown,
		mineruPayload: null,
		viewerIndex,
		visualRepair: null,
		visuals: figures.map(clippingVisual),
		pdfPath: null,
		externalPdfRecorded: false,
		issues: [],
	};
}
