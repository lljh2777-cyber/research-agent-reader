import type { PaperRecordEdit, PaperRecordEditContext } from "./record-service";
import type { LibraryPaper, PaperReadingState } from "./types";
import type { LibraryReadResult } from "./reader";

export const PAPER_READING_STATES: readonly PaperReadingState[] = ["unmarked", "not_started", "reading", "completed", "revisit"];
export interface ReadingStateHost {
	preparePaperRecord(paperId: string): Promise<PaperRecordEditContext>;
	savePaperRecord(edit: PaperRecordEdit): Promise<unknown>;
}
type Draft<T> = { context: PaperRecordEditContext; value: T; error?: string };
export type PaperRecordEditState<T> =
	| { phase: "idle" }
	| { phase: "preparing"; paperId: string }
	| { phase: "blocked"; paperId: string; error: string }
	| ({ phase: "editing" | "saving" } & Draft<T>);
export type ReadingStateEditState = PaperRecordEditState<PaperReadingState>;
interface DecisionField<T extends string | null> {
	initial(context: PaperRecordEditContext): T;
	accepts(value: string | null, context: PaperRecordEditContext): boolean;
	command(value: T): Pick<PaperRecordEdit, "readingState" | "primaryNoteId">;
}

export function readingStateBlockReason(paper: LibraryPaper, data: LibraryReadResult): string | undefined {
	if (!paper.paperId || paper.association !== "identified") return "此记录尚无唯一可靠的文献身份，暂不能保存阅读状态。";
	const record = data.recordStates.find(item => item.paperId === paper.paperId);
	if (record?.blocked) return "人工记录损坏，请先处理读取提示；本页不会覆盖历史。";
	if ((record?.heads.length || 0) > 1) return "存在并发的人工决定，请先核对冲突；本页不会自动选择或合并版本。";
	return undefined;
}

/** Holds the prepared context across user input; only an explicit save writes. */
export class PaperRecordEditor<T extends string | null> {
	state: PaperRecordEditState<T> = { phase: "idle" };
	private generation = 0;
	private closed = false;
	constructor(private readonly host: ReadingStateHost, private readonly changed: () => void, private readonly field: DecisionField<T>) {}
	get active(): boolean { return this.state.phase !== "idle"; }
	get canSave(): boolean { return this.state.phase === "editing" && this.state.value !== this.field.initial(this.state.context) && this.field.accepts(this.state.value, this.state.context); }
	private publish(state: PaperRecordEditState<T>): void { this.state = state; this.changed(); }
	async begin(paperId: string): Promise<void> {
		if (this.closed || this.active) return;
		const generation = ++this.generation;
		this.publish({ phase: "preparing", paperId });
		try {
			const context = structuredClone(await this.host.preparePaperRecord(paperId));
			if (this.closed || generation !== this.generation) return;
			if (context.paper.paperId !== paperId || context.paper.association !== "identified") throw new Error("文献关联已变化，请刷新后重新选择。");
			if (context.heads.length > 1) throw new Error("存在并发的人工决定，请先核对冲突；本页不会自动选择或合并版本。");
			this.publish({ phase: "editing", context, value: this.field.initial(context) });
		} catch (error) {
			if (!this.closed && generation === this.generation) this.publish({ phase: "blocked", paperId, error: error instanceof Error ? error.message : String(error) });
		}
	}
	setValue(value: string | null): void {
		if (this.closed || this.state.phase !== "editing" || !this.field.accepts(value, this.state.context)) return;
		// Do not rebuild native input elements while the user is choosing a value.
		this.state = { ...this.state, value: value as T };
	}
	cancel(): void {
		if (this.closed || this.state.phase === "saving") return;
		++this.generation; this.publish({ phase: "idle" });
	}
	async save(): Promise<{ paperId: string; value: T } | undefined> {
		if (this.closed || this.state.phase !== "editing" || !this.canSave) return;
		const { context, value } = this.state, generation = this.generation;
		this.publish({ phase: "saving", context, value });
		try {
			// Preserve other decisions. Never refresh away a stale edit token.
			await this.host.savePaperRecord({ paperId: context.paper.paperId!, contextHash: context.contextHash, ...this.field.command(value) });
			if (this.closed || generation !== this.generation) return;
			this.publish({ phase: "idle" });
			return { paperId: context.paper.paperId!, value };
		} catch (error) {
			if (!this.closed && generation === this.generation) this.publish({ phase: "editing", context, value, error: error instanceof Error ? error.message : String(error) });
		}
	}
	dispose(): void { this.closed = true; ++this.generation; }
}

export class ReadingStateEditor extends PaperRecordEditor<PaperReadingState> {
	constructor(host: ReadingStateHost, changed: () => void) {
		super(host, changed, {
			initial: context => context.paper.readingState,
			accepts: value => PAPER_READING_STATES.includes(value as PaperReadingState),
			command: value => ({ readingState: value }),
		});
	}
}
