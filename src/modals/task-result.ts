import { App, Modal, Notice } from "obsidian";

import type { LintStatus, TaskRun } from "../types/contracts";

interface TaskResultHost {
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
}

export class TaskResultModal extends Modal {
	private readonly plugin: TaskResultHost;
	private readonly run: TaskRun;
	private readonly onRepair: (() => void) | null;

	constructor(
		app: App,
		plugin: TaskResultHost,
		run: TaskRun,
		onRepair: (() => void) | null,
	) {
		super(app);
		this.plugin = plugin;
		this.run = run;
		this.onRepair = onRepair;
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
		const output = this.plugin.getTaskRunOutput(this.run)
			|| this.run.error
			|| "该任务尚未产生输出。";
		contentEl.createEl("pre", {
			cls: "agent-dashboard-result-output",
			text: output,
		});
		const footer = contentEl.createDiv({ cls: "agent-dashboard-modal-actions" });
		const copy = footer.createEl("button", { text: "复制结果" });
		copy.type = "button";
		copy.addEventListener("click", async () => {
			await navigator.clipboard.writeText(output);
			new Notice("任务结果已复制");
		});
		if (this.canRepair()) {
			const repair = footer.createEl("button", {
				cls: "mod-warning",
				text: "提出方案并修复",
				attr: {
					title: "AI 将逐项核验体检结果，处理确认属于低风险的结构问题，并在修改后重新体检",
				},
			});
			repair.type = "button";
			repair.addEventListener("click", () => {
				this.close();
				this.onRepair?.();
			});
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
		if (this.run.actionId === "paper-ingest" && this.run.executionConfig?.backend === "direct-api" && this.run.status !== "done" && this.plugin.continuePaperIngest) {
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
		if (this.run.actionId !== "vault-lint" || typeof this.onRepair !== "function") {
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
		this.contentEl.empty();
	}
}
