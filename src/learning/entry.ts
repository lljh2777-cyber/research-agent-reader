import type { ReadingEntry } from "../reading/entry";

/** Keep topic routing explicit; unsupported topics must never fall through to a paper session. */
export type LearningEntry = { kind: "document"; reading?: ReadingEntry } | { kind: "topic"; sessionId?: string };
export function documentLearningEntry(entry: LearningEntry): ReadingEntry | undefined {
	if (entry.kind !== "document") throw new Error("主题学习界面尚未开放");
	return entry.reading;
}
