import type { AcquisitionPhase } from "../fulltext/contracts";
import type { ResolvedIdentity } from "../papers/identity";
import type { ReadingEvidence, ReadingLearningState, ReadingSession, ReadingSource } from "../reading/types";

/** View contracts shared by the pure projection and read adapters; persistence is separate. */
export type LibraryIdentifiers = ResolvedIdentity["identifiers"];
export type LibraryContentRole = "original_quote" | "ai_explanation" | "personal_note" | "external_material" | "synthesis";
export interface LibraryAnnotationProvenance {
	format: "dashboard-blocks" | "annotation-schema-2";
	sourcePath: string;
	/** Preserve external revision and Vault identifiers without assuming their algorithms. */
	sourceRevision?: string;
	vaultId?: string;
}
export type LibraryEvidenceReference = ReadingEvidence;
export type PaperReadingState = "unmarked" | "not_started" | "reading" | "completed" | "revisit";
export type LibraryObjectKind = "record" | "source" | "session" | "note" | "annotation" | "acquisition";
export interface LibraryObjectRef { kind: LibraryObjectKind; id: string; }

interface LibraryObjectBase extends LibraryObjectRef {
	/** Canonical identifiers, validated by the owning adapter; never derived from a title. */
	identifiers: LibraryIdentifiers;
	title: string;
	paperId?: string;
	citekey?: string;
}
export type LibrarySourceVerification =
	| { state: "verified"; fingerprint: string }
	| { state: "unverified" | "missing" | "invalid"; reason: string };
export interface LibrarySourceDescription {
	format: "pdf" | "mineru" | "jats" | "markdown" | "unknown";
	path: string;
	packageKey?: string;
	sourceVersionId?: string;
	projectionId?: string;
	/** A committed original is independent of availability and acquisition success. */
	saved: boolean;
	verification: LibrarySourceVerification;
}
export interface LibraryRecordObject extends LibraryObjectBase {
	kind: "record";
	paperId: string;
	/** Provider metadata confirmed at intake; not a scientific review or source version. */
	bibliography?: ResolvedIdentity;
	readingState?: PaperReadingState;
	primaryNoteId?: string;
	/** Read projection only: a conflicted journal has identity, but no selected human decision. */
	decisionConflict?: true;
}
export interface LibrarySourceObject extends LibraryObjectBase { kind: "source"; source: LibrarySourceDescription; }
export interface LibrarySessionObject extends LibraryObjectBase {
	kind: "session";
	/** Existing validated session; the projection never changes its source or node state. */
	session: ReadingSession;
	binding?: LibrarySourceBinding;
}
export interface LibrarySourceBinding {
	state: "matched" | "changed" | "unresolved";
	sourceId?: string;
	fingerprint?: string;
	reason: string;
}
export interface LibraryNoteObject extends LibraryObjectBase {
	kind: "note";
	contentHash: string;
	/** Explicit human decision; absence means unreviewed, not implicitly approved. */
	review?: { reviewedHash: string; reviewedAt: string };
}
export interface LibraryAnnotationObject extends LibraryObjectBase {
	kind: "annotation";
	/** File containing the annotation; separate from the original source path. */
	annotationPath?: string;
	/** Missing on legacy records; do not infer content identity from file placement. */
	roles?: LibraryContentRole[];
	binding?: LibrarySourceBinding;
	provenance?: LibraryAnnotationProvenance;
}
export interface LibraryAcquisitionObject extends LibraryObjectBase { kind: "acquisition"; phase: AcquisitionPhase; }
export type LibraryObject = LibraryRecordObject | LibrarySourceObject | LibrarySessionObject | LibraryNoteObject | LibraryAnnotationObject | LibraryAcquisitionObject;

export interface LibraryCapability { available: boolean; reason: string; }
/** These describe possible UI actions, not proof that a model has read any evidence. */
export interface LibrarySourceCapabilities {
	openOriginal: LibraryCapability;
	interactiveReading: LibraryCapability;
	pageNavigation: LibraryCapability;
	structuredNavigation: LibraryCapability;
}
export interface LibraryReadingProgress {
	sessionId: string;
	source: Pick<ReadingSource, "kind" | "path" | "fingerprint">;
	archived: boolean;
	explanation: { generated: number; planned: number | null; mainCompleted: boolean };
	/** Counts only explicitly generated nodes; unmarked is kept separate from questions. */
	learning: Record<ReadingLearningState, number>;
	questionCount: number | null;
	questionScope: "marked_completed_nodes";
}
export interface LibraryObjectSummary extends LibraryObjectRef {
	title: string;
	identifiers: LibraryIdentifiers;
	bibliography?: ResolvedIdentity;
	paperId?: string;
	citekey?: string;
	source?: LibrarySourceDescription;
	capabilities?: LibrarySourceCapabilities;
	reading?: LibraryReadingProgress;
	noteReview?: { state: "unreviewed" | "reviewed" | "stale"; reviewedAt?: string };
	/** Fingerprint of the actual note read, used to detect edits during selection. */
	contentHash?: string;
	roles?: LibraryContentRole[];
	acquisitionPhase?: AcquisitionPhase;
	binding?: LibrarySourceBinding;
	annotationProvenance?: LibraryAnnotationProvenance;
	annotationPath?: string;
}
export type LibraryDiagnosticCode = "identifier_conflict" | "paper_id_conflict" | "citekey_conflict" | "citekey_collision" | "source_unavailable" | "primary_note_missing" | "source_binding" | "record_conflict";
export interface LibraryDiagnostic {
	id: string;
	code: LibraryDiagnosticCode;
	message: string;
	/** Related objects remain separately inspectable when association is blocked. */
	objects: LibraryObjectRef[];
}
export interface LibraryPaper {
	/** Deterministic, temporary view key. Never persist it as a paperId or evidence ID. */
	key: string;
	association: "identified" | "unidentified" | "conflict";
	paperId?: string;
	citekey?: string;
	title: string;
	identifiers: LibraryIdentifiers;
	objects: LibraryObjectSummary[];
	readingState: PaperReadingState;
	primaryNoteId?: string;
	diagnosticIds: string[];
}
export interface LibraryProjection {
	papers: LibraryPaper[];
	/** Shared once per issue, avoiding quadratic copies for a large conflicting group. */
	diagnostics: LibraryDiagnostic[];
	/** Test/demo and code sessions remain in their owning repository, outside this paper view. */
	excluded: LibraryObjectRef[];
}
