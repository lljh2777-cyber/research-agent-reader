import { App, Modal, Notice } from "obsidian";

import type { LintStatus, TaskRun } from "../types/contracts";
import { renderIngestProgress } from "../views/ingest-progress";

interface TaskResultHost {
	getTaskRun?(runId: string): TaskRun | null;
	subscribeTaskRuns?(listener: (progressOnly?: boolean) => void): () => void;
	stopTaskRun?(runId: string): boolean;
	getModelLabel(model: string): string;
	getReasoningLabel(reasoningEffort: string): string;
	getTaskRunOutput(run: TaskRun): string;
	isActionRunning(actionId: string): boolean;
	getLintStatus(): LintStatus;
	getMineruArticlePath?(run: TaskRun): string;
	getLightAgentRunResult?(runId: string): {
		result: { articlePath?: string; wikiPath?: string } | null;
		filesWritten: readonly string[];
	} | null;
	getTaskRunArtifacts?(run: TaskRun): { articlePath?: string; wikiPath?: string } | null;
	activateMineruReaderView?(articlePath?: string): Promise<void>;
	activateReadingWorkspace?(entry?: import("../reading/entry").ReadingEntry): Promise<void>;
	continuePaperIngest?(run: TaskRun): Promise<void>;
	registerIngestNote?(notePath: string, runId: string): Promise<void>;
	getIngestRegistrationAvailability?(notePath: string): Promise<{ eligible: boolean; reason: string }>;
	readIngestPdf?(run: TaskRun): Promise<void>;
	openVaultFile?(path: string): void;
	openJatsWikiTask?(runId: string): Promise<void>;
}

export class TaskResultModal extends Modal {
	private readonly plugin: TaskResultHost;
	private run: TaskRun;
	private unsubscribeTasks?: () => void;

	constructor(
		app: App,
		plugin: TaskResultHost,
		run: TaskRun,
	) {
		super(app);
		this.plugin = plugin;
		this.run = run;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("agent-dashboard-modal", "agent-dashboard-result-modal");
		this.setTitle(`${this.run.label} · ${this.displayStatus(this.run.status)}`);
		contentEl.createEl("p", {
			cls: "agent-dashboard-modal-description",
			text: `${this.run.agent} · ${new Date(this.run.startedAt).toLocaleString("zh-CN")}`,
		});
		if (this.run.executionConfig) {
			const config = contentEl.createDiv({ cls: "agent-dashboard-result-config" });
			const items: Array<[string, string]> = [
				["模型", this.plugin.getModelLabel(this.run.executionConfig.model)],
				[
					"推理强度",
					this.plugin.getReasoningLabel(this.run.executionConfig.reasoningEffort || ""),
				],
				["速度", this.run.executionConfig.serviceTier === "fast" ? "快速" : "标准"],
			];
			items.forEach(([label, value]) => {
				const item = config.createDiv({ cls: "agent-dashboard-result-config-item" });
				item.createSpan({ text: label });
				item.createEl("strong", { text: value });
			});
		}
		if (this.run.summary) {
			contentEl.createEl("p", {
				cls: "agent-dashboard-result-summary",
				text: this.run.summary,
			});
		}
		if (this.run.actionId === "paper-ingest") {
			const progress = contentEl.createDiv({ cls: "ingest-progress" });
			let stopping = false;
			const refresh = () => renderIngestProgress(progress, this.plugin.getTaskRun?.(this.run.id) || this.run, {
				...(this.plugin.stopTaskRun ? { stop: () => { stopping = this.plugin.stopTaskRun!(this.run.id); refresh(); } } : {}), stopping,
			});
			refresh(); this.unsubscribeTasks = this.plugin.subscribeTaskRuns?.(() => {
				const current = this.plugin.getTaskRun?.(this.run.id);
				if (current && current.status !== this.run.status) {
					this.unsubscribeTasks?.(); this.contentEl.empty(); this.run = current; this.onOpen();
				} else refresh();
			});
		}
		const output = this.plugin.getTaskRunOutput(this.run)
			|| this.run.error
			|| "该任务尚未产生输出。";
		contentEl.createEl("pre", {
			cls: "agent-dashboard-result-output",
			text: output,
		});
		const footer = contentEl.createDiv({ cls: "agent-dashboard-modal-actions" });
		if (this.run.actionId === "jats-wiki" && this.plugin.openJatsWikiTask) {
			const review = footer.createEl("button", { text: "查看草稿／继续保存", cls: "mod-cta" });
			review.onclick = () => { void this.plugin.openJatsWikiTask!(this.run.id).then(() => this.close()).catch(error => new Notice(String(error))); };
		}
		const copy = footer.createEl("button", { text: "复制结果" });
		copy.type = "button";
		copy.addEventListener("click", async () => {
			await navigator.clipboard.writeText(output);
			new Notice("任务结果已复制");
		});
		if (this.canRepair()) {
			const report = this.plugin.getLintStatus().latest;
			const findings = (report?.findings || []).filter(f => f.path && f.message && (f.severity === "error" || f.severity === "warning"));
			if (findings.length) {
				const group = footer.createEl("details"); group.createEl("summary",{text:"核对最新体检发现与修复预览"});
				const select = group.createEl("select",{attr:{"aria-label":"选择要修复的问题"}});
				findings.forEach((f,i)=>select.createEl("option",{value:String(i),text:f.path+" · "+f.message}));
				const preview = group.createEl("p");
				const inspect = group.createEl("button", { text: "打开笔记核对" });
				inspect.onclick = () => this.plugin.openVaultFile?.(findings[select.selectedIndex].path);
				const apply = group.createEl("button", { text: "确认并应用预览" });
				let revision = 0;
				const describe = async () => {
					const request = ++revision;
					apply.disabled = true;
					const f = findings[select.selectedIndex];
					preview.setText(f.message + " · 请核对原文、版本和目标。");
					const file = this.app.vault.getFileByPath(f.path);
					if (!file || !file.path.startsWith("wiki/") || file.path.startsWith("wiki/annotations/")) return;
					const link = /`([^`]+)`/.exec(f.message)?.[1];
					if (!link || /[#|\x60]/.test(link)) return;
					const original = "[[" + link + "]]";
					const resolve = () => {
						if (f.code === "cross-root-link" && link.startsWith("papers/") && this.app.vault.getAbstractFileByPath(link)) return "`" + link + "`";
						if (f.code?.includes("ambiguous") || !/link/i.test(f.code || "") || this.app.metadataCache.getFirstLinkpathDest(link,file.path)) return;
						const candidates = this.app.vault.getMarkdownFiles().filter(target => {
							const aliases = this.app.metadataCache.getFileCache(target)?.frontmatter?.aliases;
							return target.path.startsWith("wiki/") && Array.isArray(aliases) && aliases.includes(link);
						});
						if (candidates.length === 1) return "[[" + candidates[0].path.slice(0,-3) + "|" + link + "]]";
					};
					const replacement = resolve();
					if (!replacement) return;
					const before = await this.app.vault.read(file);
					const links = this.app.metadataCache.getFileCache(file)?.links?.filter(item => item.original === original) || [];
					if (request !== revision || links.length !== 1) return;
					const at = links[0].position.start.offset;
					if (before.slice(at, at + original.length) !== original) return;
					const after = before.slice(0,at) + replacement + before.slice(at + original.length);
					preview.setText(file.path + " · " + original + " → " + replacement + (f.code === "cross-root-link" ? "（保留已存在的原文路径）" : "（唯一匹配的显式别名）"));
					apply.disabled = false;
					apply.onclick = async () => {
						apply.disabled = true;
						try {
							await this.app.vault.process(file, current => {
								if (current !== before || resolve() !== replacement || this.plugin.getLintStatus().latest?.generated_at !== report?.generated_at) throw Error("依据已变化，请重新体检");
								return after;
							});
							if (await this.app.vault.read(file) !== after) throw Error("写后检查发现内容变化，请核对笔记");
							new Notice("修复已保存并核对");
						} catch (error) { new Notice(String(error)); }
					};
				};
				select.onchange = () => void describe().catch(error => new Notice(String(error)));
				select.onchange(new Event("change"));
			}
		}
		// Prefer the in-memory structured result, then artifacts persisted on
		// the TaskRun (survive plugin reloads), then the regex fallback.
		const lightResult = this.plugin.getLightAgentRunResult?.(this.run.id)?.result
			|| this.plugin.getTaskRunArtifacts?.(this.run)
			|| null;
		const articlePath = lightResult?.articlePath
			|| this.plugin.getMineruArticlePath?.(this.run)
			|| "";
		if (articlePath) {
			if (this.run.actionId === "paper-ingest" && this.plugin.activateReadingWorkspace) {
				const read = footer.createEl("button", { cls: "mod-cta", text: "开始／继续交互深读" });
				read.type = "button";
				read.addEventListener("click", async () => {
					read.disabled = true;
					try { await this.plugin.activateReadingWorkspace!({ source: { kind: "article", path: articlePath }, backend: this.run.executionConfig?.providerId || undefined }); this.close(); }
					catch (error) { new Notice(String(error)); }
					finally { read.disabled = false; }
				});
			}
			const openReader = footer.createEl("button", { text: "打开 MinerU 阅读器" });
			openReader.type = "button";
			openReader.addEventListener("click", () => {
				this.close();
				void this.plugin.activateMineruReaderView?.(articlePath);
			});
		}
		const wikiPath = lightResult?.wikiPath || "";
		if (!articlePath && wikiPath && this.run.executionConfig?.backend === "direct-api" && this.plugin.readIngestPdf) {
			const read = footer.createEl("button", { text: "从原始 PDF 进入深读" }); read.type = "button";
			read.onclick = async () => { read.disabled = true; try { await this.plugin.readIngestPdf!(this.run); this.close(); } catch (error) { new Notice(String(error)); } finally { read.disabled = false; } };
		}
		if (this.run.actionId === "paper-ingest" && this.run.executionConfig?.backend === "direct-api" && ["failed", "interrupted"].includes(this.run.status) && this.plugin.continuePaperIngest) {
			const retry = footer.createEl("button", { text: "继续完成入库" }); retry.type = "button";
			retry.onclick = async () => { retry.disabled = true; try { await this.plugin.continuePaperIngest!(this.run); this.close(); } catch (error) { new Notice(String(error)); } finally { retry.disabled = false; } };
		}
		if (wikiPath && this.plugin.openVaultFile) {
			if (this.run.actionId === "paper-ingest" && this.run.executionConfig?.backend === "direct-api" && this.plugin.registerIngestNote) {
				const register = footer.createEl("button", { text: "预览入库登记" }); register.type = "button";
				if (this.plugin.getIngestRegistrationAvailability) {
					register.disabled = true;
					void this.plugin.getIngestRegistrationAvailability(wikiPath).then(state => {
						register.disabled = !state.eligible; register.title = state.reason;
						if (!state.eligible) register.textContent = state.reason.includes("复用") ? "既有笔记，无需轻量登记" : "入库元数据待核对";
					}).catch(error => { register.title = String(error); register.textContent = "登记状态无法读取"; });
				}
				register.onclick = async () => { register.disabled = true; try { await this.plugin.registerIngestNote!(wikiPath, this.run.id); } catch (error) { new Notice(String(error)); } finally { register.disabled = false; } };
			}
			const openWiki = footer.createEl("button", { text: "打开文章 Wiki" });
			openWiki.type = "button";
			openWiki.addEventListener("click", () => {
				this.close();
				this.plugin.openVaultFile?.(wikiPath);
			});
		}
		const close = footer.createEl("button", { cls: "mod-cta", text: "关闭" });
		close.type = "button";
		close.addEventListener("click", () => this.close());
	}

	canRepair() {
		if (this.run.actionId !== "vault-lint") {
			return false;
		}
		const completedWithReport = this.run.status === "done"
			|| (
				this.run.status === "failed"
				&& this.run.exitCode === 1
				&& String(this.run.output || "").includes("Vault lint: score")
			);
		if (!completedWithReport) return false;
		if (this.plugin.isActionRunning("vault-lint-fix")) return false;
		const lintStatus = this.plugin.getLintStatus();
		const summary = lintStatus.latest?.summary;
		return Boolean(summary && (Number(summary.errors || 0) + Number(summary.warnings || 0) > 0));
	}

	displayStatus(status: string): string {
		const statuses: Record<string, string> = {
			done: "已完成",
			failed: "失败",
			interrupted: "已中断",
			running: "运行中",
			queued: "排队中",
		};
		return statuses[status] || status;
	}

	onClose() {
		this.unsubscribeTasks?.(); this.unsubscribeTasks = undefined;
		this.contentEl.empty();
	}
}
