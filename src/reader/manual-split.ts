export type ManualSplitMode = "md-pdf" | "bilingual";
export interface ManualSplitState {
	mode: ManualSplitMode; left: string; right: string; entry: string; ratio: number; linked: boolean;
	markdownProgress: number; pdfPage: number; pdfProgress: number; pdfZoom?: number; digests?: { left: string; right: string };
	bilingualState?: unknown;
}
export function splitFilePath(value: unknown, extension: "md" | "pdf"): value is string {
	return typeof value === "string" && value.length <= 600 && value.toLowerCase().endsWith("." + extension)
		&& !/[\\<>:"|?*\x00-\x1f]/.test(value) && value.split("/").every(p => !!p && p !== "." && p !== ".." && !/[. ]$/.test(p));
}
export function splitProgress(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
export function normalizeManualSplit(value: unknown): ManualSplitState {
	const r = value && typeof value === "object" ? value as Partial<ManualSplitState> : {};
	const mode = r.mode === "bilingual" ? "bilingual" : "md-pdf";
	if (!splitFilePath(r.left, "md") || !splitFilePath(r.right, mode === "bilingual" ? "md" : "pdf") || r.left === r.right) throw new Error("双栏文件组合无效，请重新选择不同的 Markdown／PDF 文件");
	return { mode, left: r.left, right: r.right, entry: r.entry === r.right ? r.right : r.left, ratio: typeof r.ratio === "number" && Number.isFinite(r.ratio) ? Math.max(0.3, Math.min(0.7, r.ratio)) : 0.5,
		linked: r.linked === true, markdownProgress: splitProgress(r.markdownProgress), pdfPage: Number.isSafeInteger(r.pdfPage) && r.pdfPage! > 0 ? r.pdfPage! : 1, pdfProgress: splitProgress(r.pdfProgress), pdfZoom: typeof r.pdfZoom === "number" && Number.isFinite(r.pdfZoom) ? Math.max(0.4, Math.min(4, r.pdfZoom)) : 1,
		...(r.digests && /^[a-f0-9]{64}$/.test(r.digests.left) && /^[a-f0-9]{64}$/.test(r.digests.right) ? { digests: { ...r.digests } } : {}), ...(r.bilingualState ? { bilingualState: r.bilingualState } : {}) };
}
