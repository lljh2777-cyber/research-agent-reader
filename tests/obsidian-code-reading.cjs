/* Native UI check with deterministic model replies. Reads fixture sources only.
 * Keeps labelled test sessions; does not run source code, export notes, or delete files. */
module.exports = async function codeReadingScenario(app) {
	const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto");
	const plugin = app.plugins.plugins["research-agent-reader"]; const service = plugin.getReadingWorkspace(); await service.ready();
	const engine = plugin.getReadingEngine(); const originalBackend = engine.backendFor;
	await plugin.activateReadingWorkspace(); const view = app.workspace.getLeavesOfType("research-interactive-reading")[0].view;
	const previousId = view.getState().sessionId; const root = view.contentEl; const cases = new Map(); const checks = [];
	const originalModals = new Set(view.modals); const closeModal = el => { const modal = [...view.modals].find(m => m.modalEl === el); if (!modal) throw new Error("Test modal not registered"); modal.close(); };
	const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
	const pause = (ms = 250) => new Promise(resolve => require("node:timers").setTimeout(resolve, ms));
	const fixtureRoot = path.resolve(__dirname, "fixtures/code-reading");
	const hashes = () => ["main.py", "helpers.py", "analysis.R", "README.md"].map(name => crypto.createHash("sha256").update(fs.readFileSync(path.join(fixtureRoot, name))).digest("hex")).join(":");
	const before = hashes();
	engine.backendFor = s => cases.has(s.id) ? cases.get(s.id).backend : originalBackend(s);
	try {
		for (const [kind, filename] of [["direct-test", fixtureRoot], ["codex-cli", path.join(fixtureRoot, "analysis.R")]]) {
			const doc = await service.loader.open("code", filename); const evidence = doc.evidence.find(e => e.language === (kind === "codex-cli" ? "r" : "python"));
			const stamp = new Date().toISOString(); const id = "r-" + crypto.randomUUID(); const session = { version: 1, id, title: "代码交互验收 · " + kind, source: doc.source, createdAt: stamp, updatedAt: stamp, nodes: [], branches: [], mainIds: [], outline: [], mainSummary: "", completed: false, backend: kind, model: "deterministic-test", purpose: "test", ui: { mode: "split", split: .5, selectedId: "", zoom: 1, scrollX: 0, scrollY: 0, collapsed: [], drafts: {}, windows: [] } };
			let calls = 0; const backend = { name: kind, model: "deterministic-test", images: false, async complete(req) { calls++; const input = JSON.parse(req.prompt); check(/代码|源码/.test(req.system), kind + " code skill loaded");
				if (input.output?.modules) return JSON.stringify({ modules: [{ title: "输入与处理流程", question: "函数做什么", evidenceIds: [evidence.id] }, { title: "流程回顾", question: "有哪些边界", evidenceIds: [evidence.id] }] });
				if (req.system.includes("代码证据选择器")) return JSON.stringify({ ids: [evidence.id], query: "positive mean", needsVisual: false });
				const answer = { title: input.question ? "追问解释" : input.currentUnit, content: (input.question || input.currentUnit) + "：从给定代码可见，先筛选正数，再计算均值。此处只做静态阅读，未运行源码。[" + evidence.id + "]", evidenceIds: [evidence.id], ...(!input.question ? { mainSummary: "已讲正数筛选与均值计算" } : {}) }; const text = JSON.stringify(answer); req.onDelta?.(text); return text;
			} }; cases.set(id, { backend }); service.documents.set(id, doc); await service.repository.add(session); await view.setState({ sessionId: id });
			check(root.textContent.includes("代码 · 静态阅读"), kind + " source badge");
			const browse = root.querySelector('button[aria-label="浏览源码"]'); browse.click(); await pause();
			const sourceModal = document.querySelector(".reading-code-source-modal"); check(sourceModal?.querySelector(".reading-code-block code"), kind + " source preview");
			check(sourceModal.querySelector(".reading-code-lines").textContent.startsWith("1"), kind + " source line numbers"); closeModal(sourceModal);
			await service.advance(id); await pause(); check(service.repository.get(id).nodes[0].status === "done" && calls === 3, kind + " planned first main unit");
			root.querySelector(".reading-advance").click(); await pause(650); check(service.repository.get(id).mainIds.length === 2 && service.repository.get(id).completed, kind + " arrow advances one unit");
			const input = root.querySelector("textarea[data-composer^='main:']"); input.value = "如果没有正数会怎样"; input.dispatchEvent(new Event("input", { bubbles: true })); input.closest(".reading-composer").querySelector(".reading-send").click(); await pause(650);
			check(service.repository.get(id).branches.length === 1 && root.querySelector(".reading-float"), kind + " branch opens");
			const first = service.repository.get(id).mainIds[0]; view.showEvidence(first, evidence.id); await pause(); const evidenceModal = [...document.querySelectorAll(".reading-modal")].find(m => m.querySelector(".reading-code-block"));
			check(evidenceModal?.textContent.includes("第 " + evidence.startLine), kind + " cited code line location"); closeModal(evidenceModal);
			root.querySelector('[data-reading-mode="map"]').click(); await pause(650); check(root.dataset.mode === "map", kind + " map mode");
			view.openExport(); await pause(); const exported = document.querySelector(".reading-export-modal"); check(exported?.textContent.includes("static-read") && exported.textContent.includes("项目代码"), kind + " code export preview"); closeModal(exported);
			await service.repository.flush(); const saved = JSON.parse(await service.repository.storage.read(id)); check(saved.source.code.files.length && saved.nodes.length === 3 && saved.ui.mode === "map", kind + " source and conversation saved");
			await view.setState({ sessionId: id }); check(root.querySelectorAll(".reading-map-node").length === 3, kind + " view restores graph");
		}
		check(hashes() === before, "all source hashes unchanged"); return { status: "passed", checks: checks.length, details: checks, sessions: [...cases.keys()] };
	} finally { for (const modal of view.modals) if (!originalModals.has(modal)) modal.close(); engine.backendFor = originalBackend; await pause(650); await service.repository.flush(); if (previousId) await view.setState({ sessionId: previousId }); }
};
