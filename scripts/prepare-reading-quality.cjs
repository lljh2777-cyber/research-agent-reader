"use strict";
// Offline preparation. Only pinned public sources enter the plan; rubrics stay out.
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process");
const baseline = require("./reading-quality-baseline.cjs"), io = require("./reading-quality-io.cjs");
function prepare(sourceRoot, output, python = process.platform === "win32" ? "D:/python/python.exe" : "python3") {
	const spec = require("../tests/fixtures/reading-quality/r0-v1.json"), checked = baseline.inspect(spec, baseline.fileReader(sourceRoot));
	const directory = io.privateTarget(output, [sourceRoot]); fs.mkdirSync(directory); fs.mkdirSync(path.join(directory, "images"));
	const requests = [...new Map(checked.modelInputs.flatMap(q => q.visuals).map(v => [v.sourceFile + ":" + (v.page || "image"), { kind: v.kind, sourceFile: v.sourceFile, sourceSha256: v.sourceSha256, ...(v.page ? { page: v.page } : {}) }])).values()];
	const images = JSON.parse(execFileSync(python, ["-X", "utf8", path.join(__dirname, "prepare-reading-quality-images.py"), fs.realpathSync(sourceRoot), path.join(directory, "images")], { input: JSON.stringify(requests), encoding: "utf8", windowsHide: true, shell: false, maxBuffer: 1024 * 1024, timeout: 120000 }));
	const plan = { schemaVersion: 1, baselineId: checked.baselineId, baselineHash: checked.baselineHash, instructionsHash: checked.instructionsHash, evaluationMode: checked.evaluationMode, sourceRoot: fs.realpathSync(sourceRoot), sourceChecks: checked.sourceChecks,
		inputs: checked.modelInputs, images, scientificReview: "pending", runnerProtocol: "rar-quality-run-1" };
	const digest = io.sha(JSON.stringify(plan)); io.save(directory, "plan.json", { ...plan, planHash: digest });
	return { directory, planHash: digest, questions: plan.inputs.length, decodedVisuals: images.length };
}
module.exports = { prepare };
if (require.main === module) {
	try { const [source, output, python] = process.argv.slice(2); if (!source || !output) throw new Error("Usage: node scripts/prepare-reading-quality.cjs <sources> <new-plan-directory> [python]"); console.log(JSON.stringify(prepare(source, output, python))); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
