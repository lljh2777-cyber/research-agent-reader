import type { JatsBundle, JatsValidation } from "./contracts";
import type { JatsProjection } from "./projection";

/** File/header validation is deterministic; the reader separately checks actual image decoding. */
export function validateJatsProjection(artifact: JatsBundle, projection: JatsProjection): JatsValidation {
	const missing = projection.assets.some(asset => !asset.path);
	return {
		kind: "jats", identityCheck: "verified", bodyCheck: projection.bodyCheck,
		assetCheck: !artifact.includeFigures ? "not_requested" : missing ? "partial" : "complete",
		requestSatisfaction: projection.bodyCheck === "partial" || (artifact.includeFigures && missing) || artifact.issues.length ? "partial" : "satisfied",
		issues: [...new Set([...artifact.issues, ...projection.issues])].slice(0, 200),
	};
}
