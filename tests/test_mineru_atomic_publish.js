"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const pluginRoot = path.resolve(__dirname, "..");
const hookEntry = path.join(pluginRoot, "tests", "mineru-atomic-publish-hooks.ts");
const hookBuild = esbuild.buildSync({
	entryPoints: [path.join(pluginRoot, "src", "agent", "mineru-publish.ts")],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	target: "node20",
	logLevel: "silent",
});
const hookModule = new Module(hookEntry, module);
hookModule.filename = hookEntry;
hookModule.paths = Module._nodeModulePaths(pluginRoot);
hookModule._compile(hookBuild.outputFiles[0].text, hookEntry);
const {
	MineruPreCommitValidationError,
	publishMineruPackage,
	resolveMineruCommand,
} = hookModule.exports;

function createFixture() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "mineru-atomic-publish-"));
	const stageRoot = path.join(base, "outside-vault-stage");
	const vaultRoot = path.join(base, "vault");
	const privateSourceRoot = path.join(base, "private-source-location");
	const privateCliRoot = path.join(base, "private-cli-location");
	fs.mkdirSync(stageRoot, { recursive: true });
	fs.mkdirSync(vaultRoot, { recursive: true });
	fs.mkdirSync(privateSourceRoot, { recursive: true });
	fs.mkdirSync(privateCliRoot, { recursive: true });
	const sourcePdf = path.join(privateSourceRoot, "demo.pdf");
	const mineruExecutable = path.join(privateCliRoot, "mineru-open-api.js");
	fs.writeFileSync(sourcePdf, Buffer.from("%PDF-1.4 fake atomic publish fixture"));
	fs.writeFileSync(mineruExecutable, "// fake MinerU entry\n", "utf8");
	return { base, stageRoot, vaultRoot, sourcePdf, mineruExecutable };
}

function writeExtraction(outputDir) {
	const resultDir = path.join(outputDir, "result");
	fs.mkdirSync(resultDir, { recursive: true });
	fs.writeFileSync(
		path.join(resultDir, "article.md"),
		"# Atomic Publish Test\n\n" + "完整正文用于验证发布边界。".repeat(20),
		"utf8",
	);
	fs.writeFileSync(
		path.join(resultDir, "demo_content_list.json"),
		JSON.stringify([{ type: "title", page_idx: 0 }]),
		"utf8",
	);
}

function makeDeps(fixture, overrides = {}) {
	const calls = [];
	return {
		calls,
		deps: {
			vaultRoot: fixture.vaultRoot,
			mineruExecutable: fixture.mineruExecutable,
			stageRoot: fixture.stageRoot,
			now: () => new Date("2026-08-31T00:00:00.000Z"),
			publishOps: overrides.publishOps,
			runCommand: async (request) => {
				calls.push(request);
				if (request.cliArgs[0] === "version") {
					return {
						exitCode: 0,
						stdout: overrides.versionStdout ?? "mineru-open-api 1.2.3",
						stderr: "",
					};
				}
				const outputIndex = request.cliArgs.indexOf("--output");
				assert.notEqual(outputIndex, -1, "extract invocation must bind an output directory");
				writeExtraction(request.cliArgs[outputIndex + 1]);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		},
	};
}

function makeArgs(fixture, citekey) {
	return {
		source: fixture.sourcePdf,
		citekey,
		model: "vlm",
		language: "en",
		ocr: false,
		formula: true,
		table: true,
		pages: "",
		timeoutSeconds: 600,
		includeSourcePdf: false,
	};
}

function testRealNpmExtensionlessCmdShimResolution() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mineru npm shim with spaces "));
	const entry = path.join(root, "node_modules", "mineru-open-api", "bin", "mineru-open-api");
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.writeFileSync(entry, "#!/usr/bin/env node\nconsole.log('fixture');\n", "utf8");
	const shim = path.join(root, "mineru-open-api.cmd");
	fs.writeFileSync(
		shim,
		'@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\mineru-open-api\\bin\\mineru-open-api" %*\r\n',
		"utf8",
	);
	assert.deepEqual(resolveMineruCommand(shim), {
		command: process.execPath,
		baseArgs: [fs.realpathSync.native ? fs.realpathSync.native(entry) : fs.realpathSync(entry)],
	});

	const tildeShim = path.join(root, "mineru-tilde.cmd");
	fs.writeFileSync(
		tildeShim,
		'@"%~dp0\\node_modules\\mineru-open-api\\bin\\mineru-open-api" %*\r\n',
		"utf8",
	);
	assert.equal(
		resolveMineruCommand(tildeShim).baseArgs[0],
		fs.realpathSync.native ? fs.realpathSync.native(entry) : fs.realpathSync(entry),
	);
}

function testCmdShimTraversalAndCommandTailAreRejected() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "mineru-malicious-shim-"));
	const root = path.join(base, "npm");
	const outside = path.join(base, "outside-entry");
	fs.mkdirSync(root);
	fs.writeFileSync(outside, "console.log('outside');\n", "utf8");
	const traversalShim = path.join(root, "traversal.cmd");
	fs.writeFileSync(traversalShim, '"%dp0%\\..\\outside-entry" %*\r\n', "utf8");
	assert.throws(() => resolveMineruCommand(traversalShim), /无法从 npm shim 解析/);

	const entry = path.join(root, "node_modules", "mineru-open-api", "bin", "mineru-open-api");
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	fs.writeFileSync(entry, "console.log('safe');\n", "utf8");
	const tailedShim = path.join(root, "tailed.cmd");
	fs.writeFileSync(
		tailedShim,
		'"%dp0%\\node_modules\\mineru-open-api\\bin\\mineru-open-api" %* & calc.exe\r\n',
		"utf8",
	);
	assert.throws(() => resolveMineruCommand(tailedShim), /无法从 npm shim 解析/);
}

async function attemptPublish(fixture, citekey, overrides = {}) {
	const configured = makeDeps(fixture, overrides);
	const result = await publishMineruPackage(
		configured.deps,
		makeArgs(fixture, citekey),
		{
			signal: overrides.signal || new AbortController().signal,
			timeoutMs: 600_000,
			validateBeforeCommit: overrides.validateBeforeCommit,
		},
	).then((receipt) => ({ receipt, error: null }), (error) => ({ receipt: null, error }));
	return { ...configured, ...result };
}

function stagingEntries(fixture, citekey) {
	const papersRoot = path.join(fixture.vaultRoot, "papers");
	if (!fs.existsSync(papersRoot)) return [];
	return fs.readdirSync(papersRoot)
		.filter((name) => name.startsWith(`.${citekey}.staging-`));
}

async function testSuccessfulAtomicPublishAndPortableManifest(fixture) {
	const citekey = "success_2026";
	const packageTarget = path.join(fixture.vaultRoot, "papers", citekey);
	let copiedTo = "";
	let renameCount = 0;
	const { receipt, error } = await attemptPublish(fixture, citekey, {
		publishOps: {
			copyPackage(source, destination) {
				copiedTo = destination;
				assert.equal(fs.existsSync(packageTarget), false, "copy must not expose the final directory");
				assert.equal(path.dirname(path.dirname(destination)), path.join(fixture.vaultRoot, "papers"));
				fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
			},
			renamePackage(source, destination) {
				renameCount += 1;
				assert.equal(source, copiedTo);
				assert.equal(destination, packageTarget);
				assert.equal(fs.existsSync(path.join(source, "article.md")), true);
				assert.equal(fs.existsSync(path.join(source, "_extraction", "manifest.json")), true);
				assert.equal(fs.existsSync(destination), false, "final path must appear only at rename");
				fs.renameSync(source, destination);
			},
		},
	});
	assert.equal(error, null);
	assert.equal(receipt.packagePath, packageTarget);
	assert.equal(renameCount, 1, "one rename must be the only final commit step");
	assert.deepEqual(stagingEntries(fixture, citekey), [], "successful publish must remove its empty staging container");

	const manifestPath = path.join(packageTarget, "_extraction", "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	assert.equal(manifest.source.path, path.basename(fixture.sourcePdf));
	assert.equal(manifest.extractor_executable, path.basename(fixture.mineruExecutable));
	assert.equal(manifest.extractor_version, "1.2.3");
	assert.equal(path.isAbsolute(manifest.source.path), false);
	assert.equal(path.isAbsolute(manifest.extractor_executable), false);
	const serialized = fs.readFileSync(manifestPath, "utf8");
	assert.equal(serialized.includes(fixture.sourcePdf.replace(/\\/g, "\\\\")), false);
	assert.equal(serialized.includes(fixture.mineruExecutable.replace(/\\/g, "\\\\")), false);
}

async function testVersionOutputCannotLeakHostPaths(fixture) {
	const citekey = "private_version_output_2026";
	const { receipt, error } = await attemptPublish(fixture, citekey, {
		versionStdout: "Loaded config from X:\\Private\\01.2.3-..\\mineru-settings.json",
	});
	assert.equal(error, null);
	const manifestPath = path.join(receipt.packagePath, "_extraction", "manifest.json");
	const serialized = fs.readFileSync(manifestPath, "utf8");
	const manifest = JSON.parse(serialized);
	assert.equal(manifest.extractor_version, "unknown");
	assert.equal(serialized.includes("X:\\\\Private"), false);
}

async function testCleanupFailureIsReported(fixture) {
	const citekey = "cleanup_failure_2026";
	const originalRmSync = fs.rmSync;
	fs.rmSync = function injectedRmFailure(target, options) {
		if (path.basename(String(target)).startsWith(`.${citekey}.staging-`)) {
			throw new Error("injected cleanup failure");
		}
		return originalRmSync.call(fs, target, options);
	};
	try {
		const { error } = await attemptPublish(fixture, citekey, {
			publishOps: {
				renamePackage() { throw new Error("injected commit failure"); },
			},
		});
		assert.match(error.message, /staging 清理失败并保留/);
		assert.equal(stagingEntries(fixture, citekey).length, 1);
	} finally {
		fs.rmSync = originalRmSync;
	}
}

async function testExistingTargetIsUntouched(fixture) {
	const citekey = "occupied_2026";
	const packageTarget = path.join(fixture.vaultRoot, "papers", citekey);
	fs.mkdirSync(packageTarget, { recursive: true });
	fs.writeFileSync(path.join(packageTarget, "competitor.txt"), "existing package", "utf8");
	let filesystemOpCalled = false;
	const { error, calls } = await attemptPublish(fixture, citekey, {
		publishOps: {
			copyPackage() { filesystemOpCalled = true; },
			renamePackage() { filesystemOpCalled = true; },
		},
	});
	assert.match(error.message, /已存在/);
	assert.equal(calls.length, 0, "existing final target must fail before invoking MinerU");
	assert.equal(filesystemOpCalled, false);
	assert.equal(fs.readFileSync(path.join(packageTarget, "competitor.txt"), "utf8"), "existing package");
	assert.deepEqual(stagingEntries(fixture, citekey), []);
}

async function testCopyFailureLeavesNoVaultResidue(fixture) {
	const citekey = "copy_failure_2026";
	const packageTarget = path.join(fixture.vaultRoot, "papers", citekey);
	const { error } = await attemptPublish(fixture, citekey, {
		publishOps: {
			copyPackage(source, destination) {
				fs.mkdirSync(destination, { recursive: true });
				fs.copyFileSync(path.join(source, "article.md"), path.join(destination, "article.md"));
				throw new Error("injected copy failure");
			},
		},
	});
	assert.match(error.message, /复制到同卷 staging 失败/);
	assert.match(error.message, /injected copy failure/);
	assert.equal(fs.existsSync(packageTarget), false, "a partial copy must never create the final directory");
	assert.deepEqual(stagingEntries(fixture, citekey), [], "failed partial staging must be removed");
}

async function testPreCommitTitleConflictLeavesNoVaultResidue(fixture) {
	const citekey = "title_conflict_2026";
	const packageTarget = path.join(fixture.vaultRoot, "papers", citekey);
	let renameCalled = false;
	const { error } = await attemptPublish(fixture, citekey, {
		validateBeforeCommit(articleMarkdown) {
			assert.match(articleMarkdown, /^# Atomic Publish Test/m);
			throw new MineruPreCommitValidationError("article.md 开头与核验标题不一致：Other Paper");
		},
		publishOps: {
			renamePackage() { renameCalled = true; },
		},
	});
	assert.ok(error instanceof MineruPreCommitValidationError);
	assert.match(error.message, /开头与核验标题不一致/);
	assert.equal(renameCalled, false, "identity conflict must be rejected before the final rename");
	assert.equal(fs.existsSync(packageTarget), false, "a wrong-PDF package must not reserve the citekey");
	assert.deepEqual(stagingEntries(fixture, citekey), [], "rejected same-volume staging must be removed");
}

async function testPreCommitConflictCleanupFailureIsExplicit(fixture) {
	const citekey = "title_conflict_cleanup_failure_2026";
	const packageTarget = path.join(fixture.vaultRoot, "papers", citekey);
	const originalRmSync = fs.rmSync;
	fs.rmSync = function injectedRmFailure(target, options) {
		if (path.basename(String(target)).startsWith(`.${citekey}.staging-`)) {
			throw new Error("injected pre-commit cleanup failure");
		}
		return originalRmSync.call(fs, target, options);
	};
	try {
		const { error } = await attemptPublish(fixture, citekey, {
			validateBeforeCommit() {
				throw new MineruPreCommitValidationError("article.md 开头与核验标题不一致：Other Paper");
			},
		});
		assert.ok(error instanceof MineruPreCommitValidationError);
		assert.equal(error.cleanupFailed, true);
		assert.match(error.stagingBasename, /^\.title_conflict_cleanup_failure_2026\.staging-/);
		assert.equal(error.message.includes(fixture.vaultRoot), false, "only the bounded staging basename may be reported");
		assert.equal(fs.existsSync(packageTarget), false);
	} finally {
		fs.rmSync = originalRmSync;
	}
}

async function testAbortAfterCopySkipsValidatorAndRename(fixture) {
	const citekey = "abort_after_copy_2026";
	const controller = new AbortController();
	let validatorCalled = false;
	let renameCalled = false;
	const { error } = await attemptPublish(fixture, citekey, {
		signal: controller.signal,
		validateBeforeCommit() { validatorCalled = true; },
		publishOps: {
			copyPackage(source, destination) {
				fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
				controller.abort();
			},
			renamePackage() { renameCalled = true; },
		},
	});
	assert.match(error.message, /发布前校验失败.*任务已取消/);
	assert.equal(validatorCalled, false);
	assert.equal(renameCalled, false);
	assert.equal(fs.existsSync(path.join(fixture.vaultRoot, "papers", citekey)), false);
	assert.deepEqual(stagingEntries(fixture, citekey), []);
}

async function testAbortInsideValidatorSkipsRename(fixture) {
	const citekey = "abort_in_validator_2026";
	const controller = new AbortController();
	let renameCalled = false;
	const { error } = await attemptPublish(fixture, citekey, {
		signal: controller.signal,
		validateBeforeCommit() { controller.abort(); },
		publishOps: {
			renamePackage() { renameCalled = true; },
		},
	});
	assert.match(error.message, /发布前校验失败.*任务已取消/);
	assert.equal(renameCalled, false);
	assert.equal(fs.existsSync(path.join(fixture.vaultRoot, "papers", citekey)), false);
	assert.deepEqual(stagingEntries(fixture, citekey), []);
}

async function testPapersJunctionOutsideVaultIsRejected() {
	const fixture = createFixture();
	const outside = path.join(fixture.base, "outside-junction-target");
	const papersRoot = path.join(fixture.vaultRoot, "papers");
	fs.mkdirSync(outside);
	fs.symlinkSync(outside, papersRoot, process.platform === "win32" ? "junction" : "dir");
	const { error, calls } = await attemptPublish(fixture, "junction_escape_2026");
	assert.match(error.message, /papers 目录不能是符号链接或 junction/);
	assert.equal(calls.length, 0, "an unsafe papers root must fail before invoking the remote extractor");
	assert.deepEqual(fs.readdirSync(outside), [], "no staging or package may be written through the junction");
}

async function testRenameFailureLeavesNoVaultResidue(fixture) {
	const citekey = "rename_failure_2026";
	const packageTarget = path.join(fixture.vaultRoot, "papers", citekey);
	const { error } = await attemptPublish(fixture, citekey, {
		publishOps: {
			renamePackage() { throw new Error("injected rename failure"); },
		},
	});
	assert.match(error.message, /原子提交失败/);
	assert.match(error.message, /injected rename failure/);
	assert.equal(fs.existsSync(packageTarget), false, "a failed rename must leave no final directory");
	assert.deepEqual(stagingEntries(fixture, citekey), [], "complete staging must be removed after commit failure");
}

async function testConcurrentTargetWinsWithoutOverwrite(fixture) {
	const citekey = "concurrent_2026";
	const packageTarget = path.join(fixture.vaultRoot, "papers", citekey);
	const { error } = await attemptPublish(fixture, citekey, {
		publishOps: {
			renamePackage(source, destination) {
				fs.mkdirSync(destination);
				fs.writeFileSync(path.join(destination, "winner.txt"), "concurrent package", "utf8");
				fs.renameSync(source, destination);
			},
		},
	});
	assert.match(error.message, /发布期间出现并发目标/);
	assert.equal(fs.readFileSync(path.join(packageTarget, "winner.txt"), "utf8"), "concurrent package");
	assert.equal(fs.existsSync(path.join(packageTarget, "article.md")), false, "losing package must not leak into the winner");
	assert.deepEqual(stagingEntries(fixture, citekey), [], "losing staging must be removed after a real rename conflict");
}

(async () => {
	testRealNpmExtensionlessCmdShimResolution();
	testCmdShimTraversalAndCommandTailAreRejected();
	const fixture = createFixture();
	await testSuccessfulAtomicPublishAndPortableManifest(fixture);
	await testVersionOutputCannotLeakHostPaths(fixture);
	await testExistingTargetIsUntouched(fixture);
	await testCopyFailureLeavesNoVaultResidue(fixture);
	await testPreCommitTitleConflictLeavesNoVaultResidue(fixture);
	await testPreCommitConflictCleanupFailureIsExplicit(fixture);
	await testAbortAfterCopySkipsValidatorAndRename(fixture);
	await testAbortInsideValidatorSkipsRename(fixture);
	await testRenameFailureLeavesNoVaultResidue(fixture);
	await testConcurrentTargetWinsWithoutOverwrite(fixture);
	await testCleanupFailureIsReported(fixture);
	await testPapersJunctionOutsideVaultIsRejected();
	console.log("MINERU_ATOMIC_PUBLISH_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
