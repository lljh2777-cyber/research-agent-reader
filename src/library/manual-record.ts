import type { LibraryRecordObject } from "./types";

/** User-supplied text, never a provider identity or a source verification receipt. */
export interface ManualBibliography {
	status: "unverified";
	authors: string[];
	year: string;
	reference: string;
	notes: string;
}
export interface ManualPaperInput { title: string; authors: string; year: string; reference: string; notes: string; }
const text = (value: unknown, max: number, multiline = false): value is string => typeof value === "string" && value.length <= max
	&& value === value.trim() && !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value);

export function decodeManualBibliography(value: unknown): ManualBibliography {
	const m = value as ManualBibliography;
	if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).sort().join() !== ["status", "authors", "year", "reference", "notes"].sort().join()
		|| m.status !== "unverified" || !Array.isArray(m.authors) || m.authors.length > 100 || m.authors.some(a => !text(a, 200) || !a)
		|| !text(m.year, 4) || m.year !== "" && !/^[12]\d{3}$/.test(m.year)
		|| !text(m.reference, 1024) || !text(m.notes, 4000, true)) throw new Error("手工书目信息无效，请核对作者、年份和文字长度");
	return structuredClone(m);
}
export function manualPaperFields(input: ManualPaperInput): Pick<LibraryRecordObject, "title" | "manualBibliography"> {
	if (!input || ["title", "authors", "year", "reference", "notes"].some(k => typeof input[k as keyof ManualPaperInput] !== "string") || input.authors.length > 21000) throw new Error("手工条目字段无效");
	const title = input.title.trim(); if (!text(title, 2000) || !title) throw new Error("请填写文献标题（最多 2000 字符）");
	const manualBibliography = decodeManualBibliography({ status: "unverified", authors: input.authors.split(/\r?\n/).map(a => a.trim()).filter(Boolean), year: input.year.trim(), reference: input.reference.trim(), notes: input.notes.trim() });
	return { title, manualBibliography };
}
export function validateManualBinding(record: Pick<LibraryRecordObject, "manualBibliography" | "bibliography" | "identifiers" | "citekey" | "primaryNoteId">): void {
	if (record.manualBibliography === undefined) return;
	decodeManualBibliography(record.manualBibliography);
	if (record.bibliography !== undefined || record.citekey !== undefined || record.primaryNoteId !== undefined || Object.keys(record.identifiers).length) throw new Error("未核验人工条目不能携带已确认身份或主要笔记关联");
}
