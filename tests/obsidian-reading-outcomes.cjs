// Native UI check. Uses existing records, restores teaching preference/view, no model calls or note writes.
module.exports = async function readingOutcomesScenario(app) {
	const check = (ok, label) => { if (!ok) throw new Error(label); };
	const pause = ms => new Promise(resolve => require("node:timers").setTimeout(resolve, ms));
	const until = async test => { for (let i = 0; i < 100; i++) { if (test()) return; await pause(80); } throw new Error("UI timeout"); };
	const p = app.plugins.plugins["research-agent-reader"]; const w = p.getReadingWorkspace(); const c = p.getCurationService(); await c.ready();
	const record = [...c.reviews.values()].find(r => r.state === "ready" && r.suggestions.some(s => s.decision === "pending")); check(record, "existing pending review");
	await p.activateReadingWorkspace(); const v = app.workspace.getLeavesOfType("research-interactive-reading").find(l => l.view.getReadingDomain?.() === "paper").view; const previous = v.getState();
	const session = w.repository.get(record.context.sessionId); const original = structuredClone(session); const fake = document.createElement("div");
	try {
		await v.setState({ sessionId: session.id }); const root = v.contentEl;
		await until(() => root.querySelector(".reading-outcome-link"));
		check([...root.querySelectorAll(".reading-outcome-link")].some(el => el.textContent.includes("待审阅")), "pending review visible");
		check(root.querySelector(".reading-usage-unrecorded")?.textContent.includes("未记录"), "old answer is not zero tokens");
		window.dispatchEvent(new Event("focus")); [...root.querySelectorAll(".reading-outcome-link")].find(el => el.textContent.includes("待审阅")).click();
		await until(() => document.querySelector(".curation-modal")); check(document.querySelector(".curation-modal").textContent.includes("未调用模型"), "opens saved review");
		document.querySelector(".curation-modal .modal-close-button, .curation-modal .modal-header-button").click();
		window.dispatchEvent(new Event("focus")); v.openModel(); const modal = [...v.modals].at(-1);
		const preference = [...modal.contentEl.querySelectorAll("select")].find(el => [...el.options].some(o => o.value === "methods")); check(preference, "teaching preference");
		preference.value = "methods"; [...modal.contentEl.querySelectorAll("button")].find(el => el.textContent === "保存").click(); await w.repository.flush();
		check(w.repository.get(session.id).teachingStyle === "methods", "preference persisted");
		const node = structuredClone(session.nodes.find(n => n.status === "done")); node.usage = [
			{ stage: "selection", model: "UI fixture", state: "cached", input: 0, output: 0, estimatedInput: 0 },
			{ stage: "answer", model: "UI fixture", state: "done", input: 0, output: 12, estimatedInput: 10 },
			{ stage: "memory", model: "UI fixture", state: "failed", estimatedInput: 80 }];
		v.renderAnswer(fake, node);
		check(fake.querySelector(".reading-usage summary").textContent.includes("2 次调用"), "cache excluded from model-call count");
		const rows = [...fake.querySelectorAll(".reading-usage-entry")].map(el => el.textContent);
		check(rows[0].includes("无模型调用"), "cache explicit"); check(rows[1].includes("输入 0 / 输出 12"), "reported zero retained"); check(rows[2].includes("未报告，文字估算约 80"), "estimate distinct");
		await v.setState(previous);
		return { status: "passed", checks: ["node links", "saved review", "old unknown usage", "teaching preference", "reported zero", "estimated usage", "cache excluded"] };
	} finally {
		fake.remove(); for (const modal of v.modals) modal.close();
		await w.repository.transact(session.id, d => { d.teachingStyle = original.teachingStyle; d.backend = original.backend; d.model = original.model; }); await v.setState(previous);
	}
};
