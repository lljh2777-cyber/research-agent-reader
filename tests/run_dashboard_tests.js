"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const commands = [
	[process.execPath, ["tests/test_release_metadata.js"]],
	[process.execPath, ["tests/test_dashboard_providers.js"]],
	[process.execPath, ["tests/test_dashboard_direct_api_boundary.js"]],
	[process.execPath, ["tests/test_vault_context.js"]],
	[process.execPath, ["tests/test_dashboard_query_view.js"]],
	[process.execPath, ["tests/test_dashboard_annotations.js"]],
	[process.execPath, ["tests/test_dashboard_obsidian_cli.js"]],
	[process.execPath, ["tests/test_dashboard_markdown_reader.js"]],
	[process.execPath, ["tests/test_dashboard_paper_actions.js"]],
	[process.execPath, ["tests/test_agent_loop.js"]],
	[process.execPath, ["tests/test_mineru_atomic_publish.js"]],
	[process.execPath, ["tests/test_task_output_persistence.js"]],
	[process.execPath, ["tests/test_dashboard_vault_lint.js"]],
	[process.execPath, ["tests/test_public_runtime_boundary.js"]],
	[process.execPath, ["tests/test_dashboard_mineru_reader.js"]],
];

for (const [command, args] of commands) {
	const result = spawnSync(command, args, {
		cwd: projectRoot,
		encoding: "utf8",
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status || 1);
}

console.log("AGENT_DASHBOARD_ALL_TESTS_OK");
