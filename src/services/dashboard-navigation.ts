/** Placement changes presentation only; action IDs and dispatch remain stable. */
export function dashboardActionGroup(id: string): "common" | "tools" {
	return ["code-analysis", "code-practice", "vault-lint", "okf-export"].includes(id) ? "tools" : "common";
}
