/* Explicit Obsidian check. Uses an existing reading session; creates no sessions or notes.
 * Calls configured retrieval models for association preview. No credential output or deletion. */
module.exports = async function knowledgeReviewScenario(app, sessionId) {
	const check = (condition, label) => { if (!condition) throw new Error(label); };
	const pause = () => new Promise(resolve => require("node:timers").setTimeout(resolve, 80));
	const settle = async test => { for (let i = 0; i < 150; i++) { if (test()) return; await pause(); } throw new Error("UI did not settle"); };
	const plugin = app.plugins.plugins["research-agent-reader"]; const service = plugin.getReadingWorkspace(); await service.ready();
	const session = service.repository.get(sessionId); check(session && session.nodes.some(node => node.status === "done"), "existing completed reading required");
	const before = app.vault.getMarkdownFiles().filter(file => file.path.startsWith("wiki/qa/")).map(file => file.path).sort().join("\n");
	await plugin.activateReadingWorkspace(); const view = app.workspace.getLeavesOfType("research-interactive-reading").find(l => l.view.getReadingDomain?.() === "paper").view;
	await view.setState({ sessionId }); await pause(); [...view.modals].forEach(modal => modal.close());
	view.contentEl.ownerDocument.defaultView.dispatchEvent(new Event("focus")); view.openExport();
	const modal = [...view.modals].find(item => item.modalEl.classList.contains("reading-export-modal")); check(modal, "export modal opens");
	try {
		await settle(() => modal.review && !modal.submit.disabled); check(modal.preview.textContent.includes(session.title), "preview contains original title");
		const scope = modal.scopeSelect; scope.value = "session"; scope.dispatchEvent(new Event("change"));
		await settle(() => modal.review && !modal.submit.disabled); check(modal.review.text.includes(session.nodes.find(node => node.status === "done").title), "scope switch renders answers");
		await modal.findAssociations(); check(!modal.submit.disabled, "association search leaves export usable"); check(modal.selected.size === 0, "associations require selection");
		const candidates = modal.candidates.length; check(candidates > 0, "actual related candidates found");
		const checkbox = modal.suggestions.querySelector("input[type=checkbox]"); checkbox.checked = true; checkbox.dispatchEvent(new Event("change"));
		await settle(() => modal.review && !modal.submit.disabled); check(modal.review.text.includes("## 关联笔记"), "selection enters reviewed note");
		scope.value = "node"; scope.dispatchEvent(new Event("change")); await settle(() => modal.review && !modal.submit.disabled);
		check(!modal.candidates.length && !modal.selected.size, "scope switch clears old associations");
		const originalGet = modal.getSession; const originalNode = modal.nodeId;
		const synthetic = structuredClone(session); const template = session.nodes.find(node => node.status === "done"); synthetic.branches = [];
		synthetic.nodes = Array.from({ length: 300 }, (_, i) => ({ ...structuredClone(template), id: "preview-" + i, parentId: i ? "preview-" + (i - 1) : null, branchId: null, question: "", quote: undefined, title: "Preview unit " + (i + 1) }));
		synthetic.mainIds = synthetic.nodes.map(node => node.id); modal.getSession = () => synthetic; modal.nodeId = "preview-0"; modal.exportScope = "session";
		await modal.refresh(); check(modal.preview.textContent.includes("Preview unit 300"), "300-node preview is complete");
		check(modal.preview.parentElement.scrollHeight > modal.preview.parentElement.clientHeight, "long preview scrolls within panel");
		check(modal.submit.getBoundingClientRect().bottom <= modal.modalEl.getBoundingClientRect().bottom, "save remains inside modal");
		modal.getSession = originalGet; modal.nodeId = originalNode; modal.exportScope = "node"; await modal.refresh();
		const retrieval = plugin.getKnowledgeService(); let embeddedInputs = 0; const models = retrieval.models; const embed = models.embed;
		try { models.embed = function (inputs, signal) { embeddedInputs += inputs.length; return embed.call(this, inputs, signal); }; await retrieval.update(); }
		finally { models.embed = embed; }
		check(embeddedInputs === 0, "unchanged index does not upload embeddings again");
		const after = app.vault.getMarkdownFiles().filter(file => file.path.startsWith("wiki/qa/")).map(file => file.path).sort().join("\n"); check(before === after, "preview writes no QA notes");
		return { status: "passed", candidates, embeddedInputs, checks: ["scope switch", "association selection", "stale selection reset", "300-node preview", "scrolling", "footer visibility", "incremental index reuse", "no note writes"] };
	} finally { modal.close(); }
};
