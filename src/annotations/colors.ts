/** Personal reading marks; no evidence or review status is implied. */
export const ANNOTATION_COLORS = { yellow: "黄色", green: "绿色", blue: "蓝色", purple: "紫色", red: "红色" } as const;
export type AnnotationColor = keyof typeof ANNOTATION_COLORS;
export type AnnotationColorChoice = AnnotationColor | "none";
export type AnnotationColorMeanings = Record<AnnotationColor, string>;
export const ANNOTATION_COLOR_MEANING_LIMIT = 40;
export const DEFAULT_ANNOTATION_COLOR_MEANINGS: Readonly<AnnotationColorMeanings> = {
	yellow: "主要结论",
	green: "数据与证据",
	blue: "方法与设计",
	purple: "概念与定义",
	red: "疑点与限制",
};

export function normalizeAnnotationColorMeanings(value: unknown): AnnotationColorMeanings {
	const result = { ...DEFAULT_ANNOTATION_COLOR_MEANINGS };
	if (!value || typeof value !== "object" || Array.isArray(value)) return result;
	for (const [key, raw] of Object.entries(value)) {
		if (!isAnnotationColor(key) || typeof raw !== "string") continue;
		const text = raw.replace(/\s+/g, " ").trim();
		const meaning = Array.from(text).slice(0, ANNOTATION_COLOR_MEANING_LIMIT).join("").trimEnd();
		if (meaning) result[key] = meaning;
	}
	return result;
}

export function annotationColorLabel(color: AnnotationColorChoice, meanings: Readonly<AnnotationColorMeanings> = DEFAULT_ANNOTATION_COLOR_MEANINGS): string {
	return color === "none" ? "无颜色" : `${ANNOTATION_COLORS[color]} · ${meanings[color]}`;
}
export function isAnnotationColor(value: unknown): value is AnnotationColor {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(ANNOTATION_COLORS, value);
}
export function annotationColor(value: unknown): AnnotationColor | undefined {
	if (value === undefined || value === "none") return undefined;
	if (!isAnnotationColor(value)) throw new Error("请选择支持的批注颜色");
	return value;
}
