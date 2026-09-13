/** Old snapshots omit converter; preserve their original deterministic projection. */
export const JATS_LEGACY_CONVERTER = "rar-jats-1";
export const JATS_V2_CONVERTER = "rar-jats-2";
export const JATS_CONVERTER = "rar-jats-3";
export function jatsConverter(value: unknown): string {
	if (value === undefined) return JATS_LEGACY_CONVERTER;
	if (value !== JATS_LEGACY_CONVERTER && value !== JATS_V2_CONVERTER && value !== JATS_CONVERTER) throw new Error("JATS 转换器版本不支持");
	return value;
}
