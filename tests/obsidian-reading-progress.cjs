/* Read real source evidence; restore UI/marks, never generate or write Wiki content. */
module.exports = async function readingProgressScenario(app) {
	const check = (ok, label) => { if (!ok) throw new Error(label); };
	const pause = ms => new Promise(resolve => require("node:timers").setTimeout(resolve, ms));
	const p = app.plugins.plugins["research-agent-reader"]; const w = p.getReadingWorkspace(); await w.ready(); await p.activateReadingWorkspace();
	const v = app.workspace.getLeavesOfType("research-interactive-reading")[0].view; const previous = v.getState(); const results = [];
	for (const kind of ["article", "pdf"]) {
		const s = [...w.repository.sessions.values()].find(s => !s.demo && s.source.kind === kind && s.nodes.some(n => n.evidence.filter(e => e.kind === "paper").length >= 2));
		check(s, kind + " real session"); const original = JSON.parse(JSON.stringify(s));
		try {
			await w.repository.transact(s.id, d => { d.ui.mode = "split"; d.ui.evidenceView = undefined; }); await v.setState({ sessionId: s.id }); await pause(150);
			const root = v.contentEl; const node = s.nodes.find(n => n.evidence.filter(e => e.kind === "paper").length >= 2); const refs = node.evidence.filter(e => e.kind === "paper");
			const select = [...root.querySelectorAll(".reading-answer select")].find(el => el.getAttribute("aria-label") === "我的理解状态：" + node.title);
			check(select, "learning control"); select.value = "question"; select.dispatchEvent(new Event("change")); await w.repository.flush();
			check(w.repository.get(s.id).nodes.find(n => n.id === node.id).learningState === "question", "mark saved");
			window.dispatchEvent(new Event("focus")); v.showEvidence(node.id, refs[0].id);
			const modal = [...v.modals].at(-1); [...modal.contentEl.querySelectorAll("button")].find(b => b.textContent === "固定原文对照").click(); await w.repository.flush();
			for (let i = 0; i < 100 && root.querySelector(".reading-evidence-panel input")?.disabled; i++) await pause(100);
			let panel = root.querySelector(".reading-evidence-panel"); check(panel, "evidence panel");
			check(panel.querySelector("pre").textContent === refs[0].text, "exact quote"); check(!panel.querySelector("input").disabled, "verified evidence can be marked");
			panel.querySelector("input").click();
			for (let i = 0; i < 100 && !w.repository.get(s.id).nodes.find(n => n.id === node.id).reviewedEvidence?.includes(refs[0].id); i++) await pause(100);
			check(w.repository.get(s.id).nodes.find(n => n.id === node.id).reviewedEvidence?.includes(refs[0].id), "human check persisted");
			panel = root.querySelector(".reading-evidence-panel"); root.querySelector('[data-reading-mode="map"]').click(); await w.repository.flush();
			check(panel === root.querySelector(".reading-evidence-panel"), "mode retains source window");
			v.showEvidence(node.id, refs[1].id); await w.repository.flush(); check(root.querySelector(".reading-evidence-panel pre").textContent === refs[1].text, "reference navigation");
			root.querySelector('.reading-evidence-panel [aria-label="上一处"]').click(); await w.repository.flush(); check(root.querySelector(".reading-evidence-panel pre").textContent === refs[0].text, "back to previous quote");
			await v.setState({ sessionId: s.id }); check(root.querySelector(".reading-evidence-panel pre").textContent === refs[0].text, "source view restored");
			results.push({ kind, checks: ["learning mark", "exact source", "human check", "mode retention", "citation history", "restore"] });
		} finally {
			await pause(350); await w.repository.flush(); await w.repository.transact(s.id, d => { d.ui = original.ui; for (const n of d.nodes) { const old = original.nodes.find(o => o.id === n.id); n.learningState = old.learningState; n.reviewedEvidence = old.reviewedEvidence; } });
		}
	}
	await v.setState(previous); return { status: "passed", results };
};
