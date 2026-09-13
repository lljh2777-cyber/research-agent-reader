import { FileSystemAdapter, Modal, Notice } from "obsidian";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type AgentDashboardPlugin from "../plugin";
import { IngestRegistrationWriter, planIngestRegistration, registrationFiles, registrationHash, ingestRegistrationAvailability, type RegistrationPlan } from "../agent/ingest-registration";
import { readTrustedVaultFile, resolveTrustedVaultPath } from "../runtime/trusted-vault-fs";
import { FileSourceStorage } from "../sources/storage";
import { verifyJatsWikiSource } from "../jats/wiki-source-guard";

export class IngestRegistrationController {
	private writer: IngestRegistrationWriter;
	private full = false; private scope = "";
	private vaultRoot: string;
	private toolkitRoot = "";
	constructor(private plugin: AgentDashboardPlugin) {
		if (!(plugin.app.vault.adapter instanceof FileSystemAdapter)) throw new Error("入库登记需要桌面文件系统");
		this.vaultRoot = plugin.app.vault.adapter.getBasePath();
		this.writer = new IngestRegistrationWriter({ read: p => this.read(p), write: (p, before, after) => this.write(p, before, after),
			verify: async plan => { const note = await this.read(plan.notePath); if (!note) throw new Error("登记笔记缺失"); await verifyJatsWikiSource(new FileSourceStorage(this.vaultRoot), plan.notePath, note); },
			save: plan => this.plugin.getIngestRecords().write("registration", plan.id, plan) });
	}
	private root(p: string): string {
		if (p === "tool-library/metadata/papers.csv" || p === "tool-library/references.bib") { if (!this.full) return ""; return this.toolkitRoot; }
		if (!["文献索引.md", "wiki/log.md", "papers/index.md"].includes(p) && !/^wiki\/sources\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md$/.test(p)) throw new Error("登记路径越界");
		return this.vaultRoot;
	}
	private async read(p: string): Promise<string | null> {
		const root = this.root(p); if (!root) return null;
		try { return (await readTrustedVaultFile({ getBasePath: () => root }, p, 4 * 1024 * 1024)).toString("utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	}
	private async write(p: string, before: string | null, after: string): Promise<void> {
		const root = this.root(p); if (!root) throw new Error("未绑定外部书目目录");
		await resolveTrustedVaultPath({ getBasePath: () => root }, path.posix.dirname(p) === "." ? "wiki" : path.posix.dirname(p), { expectedType: "directory" });
		if (await this.read(p) !== before) throw new Error("文件在写入前已变化：" + p);
		if (!p.startsWith("tool-library/")) {
			const file = this.plugin.app.vault.getFileByPath(p);
			if (!file) { if (before !== null) throw new Error("登记文件缺失"); await this.plugin.app.vault.create(p, after); }
			else await this.plugin.app.vault.process(file, text => { if (text !== before) throw new Error("文件已编辑：" + p); return after; });
		} else {
			const resolved = await resolveTrustedVaultPath({ getBasePath: () => root }, path.posix.dirname(p), { expectedType: "directory" });
			const target = path.join(resolved.realPath, path.posix.basename(p)); const pending = target + "." + randomUUID() + ".pending";
			const handle = await fs.open(pending, "wx", 0o600); try { await handle.writeFile(after, "utf8"); await handle.sync(); } finally { await handle.close(); }
			if (await this.read(p) !== before) throw new Error("书目文件已编辑，保留待写文件供核对");
			await fs.rename(pending, target);
		}
	}
	async availability(notePath: string): Promise<{ eligible: boolean; reason: string }> { return ingestRegistrationAvailability(notePath, await this.read(notePath)); }
	async open(notePath: string, id: string): Promise<void> {
		const vault = this.vaultRoot;
		let full = false;
		try { full = await fs.realpath(path.join(this.plugin.settings.toolkitRoot, "knowledge-base")) === await fs.realpath(vault); } catch { /* Standalone vault has no external registry. */ }
		const scope = JSON.stringify([vault, full ? this.plugin.settings.toolkitRoot : ""]);
		id += "-" + registrationHash(scope).slice(0, 12);
		// A settings change cannot redirect a prepared write batch.
		if (this.scope && this.scope !== scope) throw new Error("登记目录配置已变化，请重载插件后重新预览");
		this.full = full; this.scope = scope; this.toolkitRoot = full ? this.plugin.settings.toolkitRoot : "";
		let plan = await this.plugin.getIngestRecords().read("registration", id) as RegistrationPlan | null;
		if (plan && (plan.scope !== scope || plan.notePath !== notePath || plan.id !== id)) throw new Error("登记记录与当前来源或目录不一致");
		if (!plan) {
			const files: Record<string, string | null> = {}; for (const p of registrationFiles(notePath)) files[p] = await this.read(p);
			plan = planIngestRegistration(notePath, files, full, id, new Date().toISOString(), scope);
		}
		const modal = new Modal(this.plugin.app); modal.setTitle("入库登记预览"); modal.contentEl.addClass("reading-modal");
		modal.contentEl.createEl("p", { text: full ? "同步当前文献的 CSV、BibTeX、索引与日志；不会调用模型。" : "同步当前库的索引与日志。工具包未绑定到本库，外部 CSV / BibTeX 仍待登记，状态记为 indexed。" });
		if (!plan.writes.length) modal.contentEl.createEl("p", { text: "当前所选范围已经登记，无需重复写入。" });
		for (const w of plan.writes) {
			const details = modal.contentEl.createEl("details"); details.createEl("summary", { text: w.path + (w.before === null ? " · 新建" : " · 更新") });
			details.createEl("p", { text: "修改前" }); details.createEl("pre", { text: w.before ?? "（文件不存在）", cls: "reading-evidence-text" });
			details.createEl("p", { text: "修改后" }); details.createEl("pre", { text: w.after, cls: "reading-evidence-text" });
		}
		const status = modal.contentEl.createEl("p", { text: plan.state === "applied" ? "本次登记已完成，以下为保存的修订记录。" : "" }); const apply = modal.contentEl.createEl("button", { cls: "mod-cta", text: plan.state === "recovery" ? "恢复本次登记" : "确认登记" }); apply.type = "button"; apply.disabled = !plan.writes.length || plan.state === "applied";
		apply.onclick = async () => {
			if (apply.disabled) return; apply.disabled = true;
			try { if (this.scope !== JSON.stringify([vault, full ? this.plugin.settings.toolkitRoot : ""])) throw new Error("目录设置已变化，请重新预览");
				plan = await this.writer.apply(plan!); status.textContent = "登记完成，修改前后快照已保存。"; new Notice("文献登记完成");
			} catch (error) { status.textContent = String(error); apply.disabled = false; apply.textContent = "重试登记"; }
		}; modal.open();
	}
}
