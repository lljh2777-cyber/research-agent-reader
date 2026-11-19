/** Placement changes presentation only; action IDs and dispatch remain stable. */
export function dashboardActionGroup(id: string): "common" | "tools" {
	return id === "vault-retrieval" ? "common" : "tools";
}
