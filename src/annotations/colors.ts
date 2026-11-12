/** Personal reading marks; no evidence or review status is implied. */
export const ANNOTATION_COLORS = { yellow: "黄色", green: "绿色", blue: "蓝色", purple: "紫色", red: "红色" } as const;
export type AnnotationColor = keyof typeof ANNOTATION_COLORS;
export type AnnotationColorChoice = AnnotationColor | "none";
export function isAnnotationColor(value: unknown): value is AnnotationColor {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(ANNOTATION_COLORS, value);
}
export function annotationColor(value: unknown): AnnotationColor | undefined {
	if (value === undefined || value === "none") return undefined;
	if (!isAnnotationColor(value)) throw new Error("请选择支持的批注颜色");
	return value;
}
