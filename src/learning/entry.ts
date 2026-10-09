import type { ReadingEntry } from "../reading/entry";

/** Keep topic routing explicit; a topic must never fall through to a paper session. */
export type LearningEntry = { kind: "document"; reading?: ReadingEntry } | { kind: "topic"; sessionId?: string };
export function documentLearningEntry(entry: LearningEntry): ReadingEntry | undefined {
	if (entry.kind !== "document") throw new Error("主题入口不能进入资料阅读会话");
	return entry.reading;
}
