import { objectDigest } from "../papers/identity";
import type { LibraryReadResult } from "./reader";
import type { LibraryPaper, LibraryRecordObject, PaperReadingState } from "./types";
import { validatePaperRecord, type PaperRecordRevision, type PaperRecordStore } from "./record-store";

export interface PaperRecordEditContext {
	paper: LibraryPaper;
	heads: string[];
	decisions: PaperRecordRevision[];
	contextHash: string;
}
export interface PaperRecordEdit {
	paperId: string;
	contextHash: string;
	readingState?: PaperReadingState;
	/** undefined preserves the selection, null clears it. */
	primaryNoteId?: string | null;
	/** Required only when resolving multiple committed heads. No timestamp-based winner. */
	chosenHead?: string;
}

/** Only human decisions are written. The caller supplies an explicit, freshly prepared edit. */
export class PaperRecordService {
	constructor(private readonly store: PaperRecordStore, private readonly readLibrary: () => Promise<LibraryReadResult>) {}
	async prepare(paperId: string): Promise<PaperRecordEditContext> {
		const library = await this.readLibrary();
		if (library.readIssues.some(issue => issue.area !== "annotations" && issue.blocksRecords !== false)) throw new Error("文献目录读取不完整，请先处理读取问题再保存人工状态");
		const state = await this.store.read(paperId);
		if (state.errors.length) throw new Error("文献人工记录损坏，已保留历史并停止编辑");
		const listed = library.recordStates.find(item => item.paperId === paperId);
		if (objectDigest(listed?.heads || []) !== objectDigest(state.heads)) throw new Error("文献状态在准备期间变化，请重新读取");
		const matches = library.papers.filter(paper => paper.paperId === paperId);
		if (matches.length !== 1 || matches[0].association !== "identified") throw new Error("文献尚无唯一可靠的 paperId 关联，不能保存人工状态");
		const paper = matches[0];
		if (paper.objects.some(item => item.source?.verification.state === "invalid")) throw new Error("该文献原文已损坏，请先核对来源");
		const decisions = state.revisions.filter(revision => state.heads.includes(revision.digest));
		// Generation progress is not an edit precondition. Identity, membership, note content
		// and saved decision heads are, so a stale chooser cannot attach a replaced note.
		const members = paper.objects.map(({ kind, id, identifiers, paperId, citekey, contentHash }) => ({ kind, id, identifiers, paperId, citekey, contentHash }));
		const contextHash = objectDigest({ paperId, identifiers: paper.identifiers, citekey: paper.citekey, members, heads: state.heads });
		return structuredClone({ paper, heads: state.heads, decisions, contextHash });
	}
	async save(edit: PaperRecordEdit): Promise<PaperRecordRevision> {
		// Detach before awaiting: changing a UI draft while validation runs cannot change this save.
		const command = structuredClone(edit);
		if (!command || typeof command.contextHash !== "string" || !/^[a-f0-9]{64}$/.test(command.contextHash)) throw new Error("人工决定缺少编辑凭据");
		if (command.readingState === undefined && command.primaryNoteId === undefined && command.chosenHead === undefined) throw new Error("没有要保存的人工决定");
		const context = await this.prepare(command.paperId);
		if (context.contextHash !== command.contextHash) throw new Error("文献或笔记在编辑后变化，请重新读取后保存");
		if (context.heads.length > 1 && !command.chosenHead) throw new Error("存在并发决定，请显式选择要保留的版本");
		if (command.chosenHead && !context.heads.includes(command.chosenHead)) throw new Error("所选冲突版本已不是当前版本");
		const existing = context.decisions.find(revision => revision.digest === (command.chosenHead || context.heads[0]));
		const base: LibraryRecordObject = existing?.record || {
			kind: "record", id: command.paperId, paperId: command.paperId, title: context.paper.title,
			identifiers: { ...context.paper.identifiers }, ...(context.paper.citekey ? { citekey: context.paper.citekey } : {}), readingState: "unmarked",
		};
		const record = { ...base, ...(command.readingState !== undefined ? { readingState: command.readingState } : {}) };
		if (command.primaryNoteId === null) delete record.primaryNoteId;
		else if (command.primaryNoteId !== undefined) record.primaryNoteId = command.primaryNoteId;
		if (record.primaryNoteId && !context.paper.objects.some(item => item.kind === "note" && item.id === record.primaryNoteId)) throw new Error("主要笔记已缺失或属于其他文献，请重新选择或清除");
		return this.store.append(validatePaperRecord(record), context.heads);
	}
}
