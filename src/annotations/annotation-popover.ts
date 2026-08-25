import {
	App,
	Component,
	MarkdownRenderer,
	Notice,
	setIcon,
} from "obsidian";

import type { AnnotationService } from "./annotation-service";
import type {
	AnnotationDraft,
	AnnotationExplanation,
	AnnotationRecord,
	AnnotationSelection,
} from "./types";

interface AnnotationPopoverOptions {
	app: App;
	service: AnnotationService;
	anchorRect: DOMRect;
	selection?: AnnotationSelection;
	record?: AnnotationRecord;
	onArchive: (record: AnnotationRecord) => Promise<void>;
	onClose?: () => void;
}

function displayError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sectionLabel(value: string): string {
	return value.trim() || "当前段落";
}

export class AnnotationPopover extends Component {
	private readonly app: App;
	private readonly service: AnnotationService;
	private readonly anchorRect: DOMRect;
	private readonly selection?: AnnotationSelection;
	private record?: AnnotationRecord;
	private readonly onArchive: (record: AnnotationRecord) => Promise<void>;
	private readonly onClose?: () => void;
	private element: HTMLDivElement | null = null;
	private cancelGeneration: (() => void) | null = null;
	private generationVersion = 0;
	private closed = true;
	private outsideListener: ((event: PointerEvent) => void) | null = null;
	private keyListener: ((event: KeyboardEvent) => void) | null = null;
	private resizeListener: (() => void) | null = null;
	private dragMoveListener: ((event: PointerEvent) => void) | null = null;
	private dragEndListener: ((event: PointerEvent) => void) | null = null;
	private manualPosition: { left: number; top: number } | null = null;

	constructor(options: AnnotationPopoverOptions) {
		super();
		this.app = options.app;
		this.service = options.service;
		this.anchorRect = options.anchorRect;
		this.selection = options.selection;
		this.record = options.record;
		this.onArchive = options.onArchive;
		this.onClose = options.onClose;
	}

	open(): void {
		this.close();
		this.load();
		this.closed = false;
		this.element = document.body.createDiv({
			cls: "agent-annotation-popover",
			attr: {
				role: "dialog",
				"aria-label": "文字批注",
				tabindex: "-1",
			},
		});
		this.outsideListener = (event) => {
			if (!this.element?.contains(event.target as Node)) this.requestClose();
		};
		this.keyListener = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.requestClose();
			}
		};
		this.resizeListener = () => this.position();
		window.addEventListener("resize", this.resizeListener);
		window.setTimeout(() => {
			if (this.closed) return;
			document.addEventListener("pointerdown", this.outsideListener!, true);
			document.addEventListener("keydown", this.keyListener!, true);
		}, 0);
		if (this.record) this.renderExisting();
		else this.renderChooser();
	}

	close(): void {
		this.generationVersion += 1;
		if (this.cancelGeneration) {
			this.cancelGeneration();
			this.cancelGeneration = null;
		}
		if (this.outsideListener) {
			document.removeEventListener("pointerdown", this.outsideListener, true);
			this.outsideListener = null;
		}
		if (this.keyListener) {
			document.removeEventListener("keydown", this.keyListener, true);
			this.keyListener = null;
		}
		if (this.resizeListener) {
			window.removeEventListener("resize", this.resizeListener);
			this.resizeListener = null;
		}
		this.stopDragging();
		this.manualPosition = null;
		this.element?.remove();
		this.element = null;
		this.unload();
		if (!this.closed) {
			this.closed = true;
			this.onClose?.();
		}
	}

	private requestClose(): void {
		if (
			this.element?.querySelector("textarea[data-dirty='true']")
			&& !window.confirm("存在尚未保存的批注，确定取消吗？")
		) {
			return;
		}
		this.close();
	}

	private renderChooser(): void {
		const element = this.reset();
		this.renderHeader(element, this.selection?.selectedText || "", "选择批注方式");
		const actions = element.createDiv({ cls: "agent-annotation-choice-list" });
		const manual = actions.createEl("button", {
			cls: "agent-annotation-choice",
			attr: { type: "button" },
		});
		const manualIcon = manual.createSpan({ cls: "agent-annotation-choice-icon" });
		setIcon(manualIcon, "square-pen");
		const manualText = manual.createDiv();
		manualText.createEl("strong", { text: "手动批注" });
		manualText.createSpan({ text: "记录自己的理解、疑问或提醒" });
		const ai = actions.createEl("button", {
			cls: "agent-annotation-choice",
			attr: { type: "button" },
		});
		const aiIcon = ai.createSpan({ cls: "agent-annotation-choice-icon" });
		setIcon(aiIcon, "sparkles");
		const aiText = ai.createDiv();
		aiText.createEl("strong", { text: "AI 解释" });
		aiText.createSpan({ text: "结合当前段落和文章语境生成初步解释" });
		manual.addEventListener("click", () => this.renderManual());
		ai.addEventListener("click", () => void this.renderExplanation());
		this.position();
		window.setTimeout(() => this.element?.focus({ preventScroll: true }), 0);
	}

	private renderManual(): void {
		const element = this.reset();
		this.renderHeader(element, this.selection?.selectedText || "", "手动批注");
		const textarea = element.createEl("textarea", {
			cls: "agent-annotation-editor",
			attr: {
				rows: "7",
				placeholder: "输入你的批注……",
			},
		});
		textarea.addEventListener("input", () => {
			textarea.dataset.dirty = textarea.value.trim() ? "true" : "false";
		});
		const footer = this.renderFooter(element);
		const cancel = footer.createEl("button", { text: "取消", attr: { type: "button" } });
		const save = footer.createEl("button", {
			cls: "mod-cta",
			text: "保留",
			attr: { type: "button" },
		});
		cancel.addEventListener("click", () => this.renderChooser());
		const submit = async () => {
			const manualText = textarea.value.trim();
			if (!manualText) {
				new Notice("请输入批注内容");
				textarea.focus();
				return;
			}
			await this.saveNew({ manualText }, save);
		};
		save.addEventListener("click", () => void submit());
		textarea.addEventListener("keydown", (event) => {
			if (event.ctrlKey && event.key === "Enter") {
				event.preventDefault();
				void submit();
			}
		});
		this.position();
		window.setTimeout(() => textarea.focus(), 0);
	}

	private async renderExplanation(): Promise<void> {
		if (!this.selection) return;
		const generationVersion = ++this.generationVersion;
		const element = this.reset();
		this.renderHeader(element, this.selection.selectedText, "AI 解释");
		const status = element.createDiv({ cls: "agent-annotation-loading" });
		const spinner = status.createSpan({ cls: "agent-annotation-spinner" });
		spinner.setAttribute("aria-hidden", "true");
		status.createSpan({ text: "正在结合当前段落生成解释……" });
		const footer = this.renderFooter(element);
		const cancel = footer.createEl("button", { text: "取消", attr: { type: "button" } });
		cancel.addEventListener("click", () => {
			this.cancelGeneration?.();
			this.cancelGeneration = null;
			this.generationVersion += 1;
			this.renderChooser();
		});
		this.position();
		try {
			const explanation = await this.service.generateExplanation(
				this.selection,
				(cancelRequest) => {
					this.cancelGeneration = cancelRequest;
				},
			);
			this.cancelGeneration = null;
			if (this.closed || generationVersion !== this.generationVersion) return;
			this.renderExplanationResult(explanation);
		} catch (error) {
			this.cancelGeneration = null;
			if (this.closed || generationVersion !== this.generationVersion) return;
			this.renderFailure("AI 解释失败", displayError(error), () => void this.renderExplanation());
		}
	}

	private renderExplanationResult(explanation: AnnotationExplanation): void {
		const element = this.reset();
		this.renderHeader(element, this.selection?.selectedText || "", "AI 解释");
		this.renderMarkdown(
			element.createDiv({ cls: "agent-annotation-ai-result markdown-rendered" }),
			explanation.text,
		);
		const model = element.createDiv({ cls: "agent-annotation-model" });
		model.createSpan({ text: explanation.provider });
		model.createSpan({ text: explanation.model });
		const footer = this.renderFooter(element);
		const cancel = footer.createEl("button", { text: "取消", attr: { type: "button" } });
		const save = footer.createEl("button", {
			cls: "mod-cta",
			text: "保留",
			attr: { type: "button" },
		});
		const archive = footer.createEl("button", {
			cls: "agent-annotation-archive-button",
			text: "保留并存档",
			attr: { type: "button" },
		});
		cancel.addEventListener("click", () => this.renderChooser());
		const draft: AnnotationDraft = {
			aiText: explanation.text,
			aiProvider: explanation.provider,
			aiModel: explanation.model,
		};
		save.addEventListener("click", () => void this.saveNew(draft, save));
		archive.addEventListener("click", async () => {
			const record = await this.saveNew(draft, archive, false);
			if (!record) return;
			this.close();
			void this.onArchive(record);
		});
		this.position();
		window.setTimeout(() => save.focus(), 0);
	}

	private renderExisting(): void {
		if (!this.record) return;
		const element = this.reset();
		this.renderHeader(element, this.record.selectedText, sectionLabel(this.record.section));
		this.renderTextSection(element, "手动批注", this.record.manualText, "暂无手动批注");
		this.renderTextSection(element, "AI 解释", this.record.aiText, "暂无 AI 解释");
		if (this.record.archiveStatus !== "none" || this.record.archiveTargets.length) {
			const archive = element.createDiv({ cls: "agent-annotation-archive-state" });
			archive.createEl("strong", {
				text: {
					pending: "正在归档",
					completed: "已关联知识节点",
					failed: "归档失败",
					none: "未归档",
				}[this.record.archiveStatus],
			});
			if (this.record.archiveTargets.length) {
				const links = archive.createDiv({ cls: "agent-annotation-targets" });
				this.record.archiveTargets.forEach((target) => {
					const button = links.createEl("button", {
						text: target.split("/").pop() || target,
						attr: { type: "button" },
					});
					button.addEventListener("click", () => {
						void this.service.openArchiveTarget(this.record!, target);
					});
				});
			}
			if (this.record.archiveError) archive.createSpan({ text: this.record.archiveError });
		}
		const footer = this.renderFooter(element);
		if (
			this.record.aiText
			&& this.record.archiveStatus !== "pending"
			&& this.record.archiveStatus !== "completed"
		) {
			const archiveButton = footer.createEl("button", {
				cls: "agent-annotation-archive-button",
				text: this.record.archiveStatus === "failed" ? "重新归档" : "归档",
				attr: { type: "button" },
			});
			archiveButton.addEventListener("click", () => {
				const record = this.record!;
				this.close();
				void this.onArchive(record);
			});
		}
		const edit = footer.createEl("button", {
			cls: "mod-cta",
			text: "修改",
			attr: { type: "button" },
		});
		edit.addEventListener("click", () => this.renderEditor());
		this.position();
	}

	private renderEditor(): void {
		if (!this.record) return;
		const element = this.reset();
		this.renderHeader(element, this.record.selectedText, "修改批注");
		const manualLabel = element.createEl("label", { cls: "agent-annotation-field" });
		manualLabel.createSpan({ text: "手动批注" });
		const manual = manualLabel.createEl("textarea", { attr: { rows: "5" } });
		manual.value = this.record.manualText;
		const aiLabel = element.createEl("label", { cls: "agent-annotation-field" });
		const aiHeader = aiLabel.createDiv({ cls: "agent-annotation-field-header" });
		aiHeader.createSpan({ text: "AI 解释" });
		const regenerate = aiHeader.createEl("button", {
			text: "重新解释",
			attr: { type: "button" },
		});
		const ai = aiLabel.createEl("textarea", { attr: { rows: "8" } });
		ai.value = this.record.aiText;
		const markDirty = (textarea: HTMLTextAreaElement) => {
			textarea.dataset.dirty = "true";
		};
		manual.addEventListener("input", () => markDirty(manual));
		ai.addEventListener("input", () => markDirty(ai));
		regenerate.addEventListener("click", () => void this.regenerateExisting(ai, regenerate));
		const footer = this.renderFooter(element);
		const cancel = footer.createEl("button", { text: "取消", attr: { type: "button" } });
		const save = footer.createEl("button", {
			cls: "mod-cta",
			text: "保存",
			attr: { type: "button" },
		});
		cancel.addEventListener("click", () => this.renderExisting());
		const submit = async () => {
			save.disabled = true;
			try {
				this.record = await this.service.updateAnnotation(this.record!, {
					manualText: manual.value,
					aiText: ai.value,
					aiProvider: this.record?.aiProvider,
					aiModel: this.record?.aiModel,
				});
				new Notice("批注已保存");
				this.renderExisting();
			} catch (error) {
				new Notice(`保存失败：${displayError(error)}`);
				save.disabled = false;
			}
		};
		save.addEventListener("click", () => void submit());
		element.addEventListener("keydown", (event) => {
			if (event.ctrlKey && event.key === "Enter") {
				event.preventDefault();
				void submit();
			}
		});
		this.position();
		window.setTimeout(() => manual.focus(), 0);
	}

	private async regenerateExisting(
		target: HTMLTextAreaElement,
		button: HTMLButtonElement,
	): Promise<void> {
		if (!this.record) return;
		if (target.value.trim() && !window.confirm("重新解释会替换当前 AI 解释，是否继续？")) return;
		button.disabled = true;
		button.setText("生成中");
		try {
			const context = await this.service.getRecordExplanationContext(this.record);
			const explanation = await this.service.generateExplanation(context, (cancel) => {
				this.cancelGeneration = cancel;
			});
			this.cancelGeneration = null;
			target.value = explanation.text;
			target.dataset.dirty = "true";
			this.record = {
				...this.record,
				aiProvider: explanation.provider,
				aiModel: explanation.model,
			};
			button.setText("已生成");
		} catch (error) {
			this.cancelGeneration = null;
			new Notice(`重新解释失败：${displayError(error)}`);
			button.setText("重新解释");
		} finally {
			button.disabled = false;
		}
	}

	private async saveNew(
		draft: AnnotationDraft,
		button: HTMLButtonElement,
		closeAfterSave = true,
	): Promise<AnnotationRecord | null> {
		if (!this.selection) return null;
		button.disabled = true;
		try {
			const record = await this.service.createAnnotation(this.selection, draft);
			this.record = record;
			new Notice("批注已保留");
			if (closeAfterSave) this.close();
			return record;
		} catch (error) {
			new Notice(`保存批注失败：${displayError(error)}`);
			button.disabled = false;
			return null;
		}
	}

	private renderFailure(title: string, message: string, retry: () => void): void {
		const element = this.reset();
		this.renderHeader(element, this.selection?.selectedText || this.record?.selectedText || "", title);
		element.createDiv({ cls: "agent-annotation-error", text: message });
		const footer = this.renderFooter(element);
		const cancel = footer.createEl("button", { text: "取消", attr: { type: "button" } });
		const retryButton = footer.createEl("button", {
			cls: "mod-cta",
			text: "重试",
			attr: { type: "button" },
		});
		cancel.addEventListener("click", () => {
			if (this.record) this.renderExisting();
			else this.renderChooser();
		});
		retryButton.addEventListener("click", retry);
		this.position();
	}

	private renderHeader(parent: HTMLElement, selectedText: string, subtitle: string): void {
		const header = parent.createDiv({
			cls: "agent-annotation-header",
			attr: { "data-agent-drag-handle": "true" },
		});
		const title = header.createDiv();
		title.createEl("strong", { text: selectedText.slice(0, 120) });
		title.createSpan({ text: subtitle });
		const close = header.createEl("button", {
			cls: "clickable-icon",
			attr: {
				type: "button",
				"aria-label": "关闭",
			},
		});
		setIcon(close, "x");
		close.addEventListener("click", () => this.requestClose());
		header.addEventListener("pointerdown", (event) => this.startDragging(event));
	}

	private renderTextSection(
		parent: HTMLElement,
		title: string,
		content: string,
		emptyText: string,
	): void {
		const section = parent.createDiv({ cls: "agent-annotation-section" });
		section.createEl("h4", { text: title });
		if (!content) {
			section.createDiv({ cls: "agent-annotation-empty", text: emptyText });
			return;
		}
		this.renderMarkdown(
			section.createDiv({ cls: "agent-annotation-section-content markdown-rendered" }),
			content,
		);
	}

	private renderMarkdown(parent: HTMLElement, markdown: string): void {
		const sourcePath = this.record?.sourcePath || this.selection?.sourcePath || "";
		void MarkdownRenderer.render(
			this.app,
			markdown,
			parent,
			sourcePath,
			this,
		);
	}

	private renderFooter(parent: HTMLElement): HTMLDivElement {
		return parent.createDiv({ cls: "agent-annotation-footer" });
	}

	private reset(): HTMLDivElement {
		if (!this.element) throw new Error("批注小窗尚未打开");
		this.element.empty();
		return this.element;
	}

	private startDragging(event: PointerEvent): void {
		if (event.button !== 0 || !this.element) return;
		const target = event.target;
		if (
			!(target instanceof Element)
			|| target.closest("button, input, textarea, select, a")
		) {
			return;
		}
		event.preventDefault();
		this.stopDragging();
		const pointerId = event.pointerId;
		const box = this.element.getBoundingClientRect();
		const origin = { left: box.left, top: box.top };
		const start = { x: event.clientX, y: event.clientY };
		this.manualPosition = origin;
		this.element.classList.add("is-dragging");
		this.dragMoveListener = (moveEvent) => {
			if (moveEvent.pointerId !== pointerId || !this.element) return;
			moveEvent.preventDefault();
			const next = this.clampPosition(
				origin.left + moveEvent.clientX - start.x,
				origin.top + moveEvent.clientY - start.y,
			);
			this.manualPosition = next;
			this.element.style.left = `${next.left}px`;
			this.element.style.top = `${next.top}px`;
		};
		this.dragEndListener = (endEvent) => {
			if (endEvent.pointerId !== pointerId) return;
			this.stopDragging();
		};
		document.addEventListener("pointermove", this.dragMoveListener, true);
		document.addEventListener("pointerup", this.dragEndListener, true);
		document.addEventListener("pointercancel", this.dragEndListener, true);
	}

	private stopDragging(): void {
		if (this.dragMoveListener) {
			document.removeEventListener("pointermove", this.dragMoveListener, true);
			this.dragMoveListener = null;
		}
		if (this.dragEndListener) {
			document.removeEventListener("pointerup", this.dragEndListener, true);
			document.removeEventListener("pointercancel", this.dragEndListener, true);
			this.dragEndListener = null;
		}
		this.element?.classList.remove("is-dragging");
	}

	private clampPosition(left: number, top: number): { left: number; top: number } {
		if (!this.element) return { left, top };
		const margin = 12;
		const box = this.element.getBoundingClientRect();
		const maxLeft = Math.max(margin, window.innerWidth - box.width - margin);
		const maxTop = Math.max(margin, window.innerHeight - box.height - margin);
		return {
			left: Math.min(Math.max(margin, left), maxLeft),
			top: Math.min(Math.max(margin, top), maxTop),
		};
	}

	private position(): void {
		if (!this.element) return;
		window.requestAnimationFrame(() => {
			if (!this.element) return;
			const margin = 12;
			const gap = 10;
			const width = Math.min(520, window.innerWidth - margin * 2);
			this.element.style.width = `${Math.max(300, width)}px`;
			const box = this.element.getBoundingClientRect();
			if (this.manualPosition) {
				const next = this.clampPosition(
					this.manualPosition.left,
					this.manualPosition.top,
				);
				this.manualPosition = next;
				this.element.style.left = `${next.left}px`;
				this.element.style.top = `${next.top}px`;
				return;
			}
			const left = Math.min(
				Math.max(margin, this.anchorRect.left),
				Math.max(margin, window.innerWidth - box.width - margin),
			);
			let top = this.anchorRect.bottom + gap;
			if (top + box.height > window.innerHeight - margin) {
				top = this.anchorRect.top - box.height - gap;
			}
			top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));
			this.element.style.left = `${left}px`;
			this.element.style.top = `${top}px`;
		});
	}
}
