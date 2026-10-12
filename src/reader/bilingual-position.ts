import type { BilingualDocument, BilingualLanguage } from "./bilingual-document";

export interface BilingualPosition { blockId: string; progress: number; }
export interface BilingualReadingState {
	linked: boolean; active: BilingualLanguage;
	digests: Record<BilingualLanguage, string>; positions: Record<BilingualLanguage, BilingualPosition>;
}
export interface BilingualGeometry { blockId: string; top: number; }
const bounded = (n: unknown): number => typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function normalizeBilingualState(value: unknown, doc: BilingualDocument, defaultLinked = true): BilingualReadingState {
	const input = object(value), digests = object(input.digests), positions = object(input.positions);
	const position = (language: BilingualLanguage): BilingualPosition => {
		const saved = object(positions[language]);
		return digests[language] === doc.files[language].digest && doc.files[language].blocks.some(b => b.id === saved.blockId)
			? { blockId: String(saved.blockId), progress: bounded(saved.progress) } : { blockId: doc.files[language].blocks[0]?.id || "", progress: 0 };
	};
	return { linked: doc.syncAvailable && (typeof input.linked === "boolean" ? input.linked : defaultLinked), active: input.active === "zh-CN" ? "zh-CN" : "en",
		digests: { en: doc.files.en.digest, "zh-CN": doc.files["zh-CN"].digest }, positions: { en: position("en"), "zh-CN": position("zh-CN") } };
}
function ordered(geometry: BilingualGeometry[]): BilingualGeometry[] { return geometry.filter(b => Number.isFinite(b.top)).sort((a, b) => a.top - b.top); }
export function bilingualPositionAt(geometry: BilingualGeometry[], scrollTop: number, contentHeight: number): BilingualPosition | null {
	const blocks = ordered(geometry); if (!blocks.length) return null;
	let index = 0; for (let i = 0; i < blocks.length; i++) { if (blocks[i].top <= scrollTop + 0.5) index = i; else break; }
	const current = blocks[index], next = blocks.slice(index + 1).find(b => b.top > current.top + 0.5)?.top ?? contentHeight;
	return { blockId: current.blockId, progress: bounded((scrollTop - current.top) / Math.max(1, next - current.top)) };
}
export function bilingualScrollTarget(geometry: BilingualGeometry[], position: BilingualPosition, contentHeight: number, maxScroll: number): number | null {
	const blocks = ordered(geometry), index = blocks.findIndex(b => b.blockId === position.blockId); if (index < 0) return null;
	const current = blocks[index], next = blocks.slice(index + 1).find(b => b.top > current.top + 0.5)?.top ?? contentHeight;
	return Math.max(0, Math.min(maxScroll, current.top + bounded(position.progress) * Math.max(0, next - current.top)));
}
export function correspondingBilingualPosition(doc: BilingualDocument, from: BilingualLanguage, position: BilingualPosition): BilingualPosition | null {
	if (!doc.syncAvailable) return null;
	const pair = doc.pairs.find(p => p[from].id === position.blockId), target = from === "en" ? "zh-CN" : "en";
	return pair ? { blockId: pair[target].id, progress: bounded(position.progress) } : null;
}
