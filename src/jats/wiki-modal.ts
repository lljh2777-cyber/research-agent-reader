import { Modal, Notice } from "obsidian";
import type AgentDashboardPlugin from "../plugin";

export async function openJatsWiki(plugin: AgentDashboardPlugin, key: string, requestId?: string): Promise<void> {
	const service = plugin.getJatsWikiService(); await service.ready(); const context = await service.inspect(key);
	const modal = new Modal(plugin.app); let closed = false, busy = false, current = requestId || service.list(key)[0]?.request.id || "", revision = 0, uiError = "", wikiExists = !!context.existing;
	if (!plugin.trackAcquisitionDialog(modal)) throw new Error("插件已关闭");
	modal.modalEl.addClass("rar-fulltext-modal", "rar-jats-wiki-modal"); modal.setTitle("JATS 文章 Wiki");
	modal.contentEl.createEl("h3", { text: context.source.manifest.identity.title });
	modal.contentEl.createEl("p", { text: "从已保存并核验的 JATS 原文生成初步文章笔记。生成会将选定正文片段发送到所选模型；不调用 MinerU。草稿保存在本机，核对后再保存 Wiki。" });
	modal.contentEl.createEl("p", { text: `来源版本：${context.source.manifest.sourceVersionId}。深度最高为 abstract-level；没有 PDF 页码，图表尚未逐项核验。` });
	const paths = modal.contentEl.createEl("details"); paths.createEl("summary", { text: "原文与保存位置" }); paths.createEl("code", { text: `papers/${key}/article.md → wiki/sources/${context.source.manifest.citekey}.md` });
	for (const issue of context.warnings) modal.contentEl.createEl("p", { text: issue, cls: "rar-fulltext-muted" });
	const profiles = plugin.getVerifiedProviderProfiles(), label = modal.contentEl.createEl("label", { text: "生成模型" }), profile = label.createEl("select", { attr: { "aria-label": "JATS Wiki 生成模型" } });
	for (const p of profiles) profile.createEl("option", { value: p.id, text: `${p.name} · ${p.model}` });
	if (!profiles.length) modal.contentEl.createEl("p", { text: "生成新草稿需要已通过连接测试的 Direct API；已有草稿仍可核对和保存。" });
	const notes = modal.contentEl.createEl("textarea", { attr: { "aria-label": "JATS Wiki 任务说明", placeholder: "可选：关注的问题（最多 4000 字符）", maxlength: "4000" } });
	const generate = modal.contentEl.createEl("button", { text: "生成新草稿", cls: "mod-cta", attr: { "data-jats-wiki": "generate" } });
	const history = modal.contentEl.createEl("select", { attr: { "aria-label": "JATS Wiki 草稿历史" } });
	const status = modal.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
	const stop = modal.contentEl.createEl("button", { text: "停止生成", attr: { "data-jats-wiki": "stop" } }); stop.onclick = () => { if (current) service.stop(current); };
	const output = modal.contentEl.createDiv(), actions = modal.contentEl.createDiv();
	const existingActions = (notePath: string, id: string): void => {
		const open = actions.createEl("button", { text: "打开文章 Wiki", attr: { "data-jats-wiki": "open" } }); open.onclick = () => plugin.openVaultFile(notePath);
		const register = actions.createEl("button", { text: "预览入库登记", attr: { "data-jats-wiki": "register" } });
		register.onclick = () => void plugin.registerIngestNote(notePath, id).catch(error => new Notice(String(error)));
		register.disabled = true; void plugin.getIngestRegistrationAvailability(notePath).then(state => { if (!closed && register.isConnected) { register.disabled = !state.eligible; register.title = state.reason; } }).catch(error => { if (!closed) status.setText(String(error)); });
	};
	const update = (): void => {
		if (closed) return; const rows = service.list(key), active = rows.find(r => r.phase === "generating" || r.phase === "saving");
		if (active) current = active.request.id;
		const previous = history.value; history.empty(); history.createEl("option", { value: "", text: "选择已保存的草稿记录" });
		for (const row of rows) history.createEl("option", { value: row.request.id, text: new Date(row.request.created).toLocaleString("zh-CN", { hour12: false }) + " · " + ({ generating: "生成中", saving: "保存中", draft: "草稿待核对", saved: "已保存 Wiki", failed: "生成失败", interrupted: "生成中断" })[row.phase] });
		history.value = current || previous; const row = service.get(current); status.setText(uiError || (row ? row.detail + (row.error ? "\n" + row.error : "") : context.existing ? "同论文的 Wiki 已存在，未重新生成或覆盖。" : "生成草稿前仅核对来源与目录，不写入文章笔记。"));
		generate.disabled = busy || !!active || !profiles.length || wikiExists; stop.hidden = !active || active.phase !== "generating";
	};
	const show = async (): Promise<void> => {
		const seq = ++revision; output.empty(); actions.empty(); update(); const row = service.get(current);
		if (row?.draft) {
			try {
				const preview = await service.preview(current); if (closed || seq !== revision) return;
				output.createEl("h4", { text: preview.record.draft!.draft.title_zh });
				const text = output.createEl("details"); text.open = true; text.createEl("summary", { text: row.phase === "saved" ? "生成时的完整草稿（保留记录）" : "核对文章 Wiki 完整内容" }); text.createEl("pre", { text: preview.content, cls: "rar-jats-xml-evidence" });
				const evidence = output.createEl("details"); evidence.createEl("summary", { text: "实际读取的原文片段" });
				for (const item of preview.record.draft!.evidence) { evidence.createEl("code", { text: item.id }); evidence.createEl("pre", { text: item.text, cls: "rar-jats-xml-evidence" }); }
				const save = actions.createEl("button", { text: row.phase === "saved" ? "Wiki 已保存" : "保存文章 Wiki", cls: "mod-cta", attr: { "data-jats-wiki": "save" } }); save.disabled = row.phase === "saved" || busy;
				save.onclick = async () => { if (busy) return; busy = true; uiError = ""; save.disabled = true; update(); try { await service.save(preview.record.request.id, preview.record.draft!.digest); wikiExists = true; } catch (error) { uiError = String(error); } finally { busy = false; if (!closed) await show(); } };
				if (row.notePath) existingActions(row.notePath, row.request.id);
			} catch (error) { if (!closed && seq === revision) status.setText("保留历史草稿，暂不能保存：" + String(error)); }
		} else if (context.existing) existingActions(context.existing.path, "jats-" + context.source.manifest.digest.slice(0, 24));
	};
	history.onchange = () => { current = history.value; uiError = ""; void show(); };
	generate.onclick = async () => {
		if (busy || generate.disabled) return; busy = true; uiError = ""; update();
		try { const row = await service.generate(key, context.source.manifest.digest, profile.value, notes.value); current = row.request.id; }
		catch (error) { uiError = String(error); }
		finally { busy = false; if (!closed) await show(); }
	};
	const unsubscribe = service.subscribe(() => { update(); if (!busy) void show(); }); const close = modal.onClose.bind(modal); modal.onClose = () => { closed = true; revision++; unsubscribe(); close(); };
	await show(); modal.open();
}
