import type { PaperRecordEditContext } from "./record-service";
import { PaperRecordEditor, type ReadingStateHost } from "./reading-state-editor";

/** Read the actual decision: the projection intentionally omits missing primary notes. */
export function savedPrimaryNote(context: PaperRecordEditContext): string | null {
	return context.decisions.find(item => item.digest === context.heads[0])?.record.primaryNoteId ?? context.paper.primaryNoteId ?? null;
}
export const primaryNoteCandidates = (context: PaperRecordEditContext) => context.paper.objects.filter(item => item.kind === "note");

export class PrimaryNoteEditor extends PaperRecordEditor<string | null> {
	constructor(host: ReadingStateHost, changed: () => void) {
		super(host, changed, {
			initial: savedPrimaryNote,
			accepts: (value, context) => value === null || primaryNoteCandidates(context).some(item => item.id === value),
			command: value => ({ primaryNoteId: value }),
		});
	}
}
