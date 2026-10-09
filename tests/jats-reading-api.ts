// Prebundle under regular Node; never run esbuild inside Obsidian's renderer.
export { openStructuredDocument } from "../src/reading/structured-document";
export { loadJatsDocument } from "../src/reader/jats-document";
export { ReadingRepository } from "../src/reading/store";
export { ReadingWorkspaceService } from "../src/reading/workspace";
export { ReadingEngine } from "../src/reading/engine";
export { createReadingSession, addReadingNode, addReadingBranch } from "../src/reading/session";
export { readingExportContent, readingExportHash } from "../src/reading/export";
export { visitReadingEvidence } from "../src/reading/progress";
