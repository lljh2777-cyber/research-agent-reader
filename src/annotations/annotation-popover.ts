import { GPT_ANNOTATION_MODELS, gptOptions, supportsGptAnnotations, type GptChoices } from "./gpt-options";
import type { TopicPassage } from "../learning/entry";
import { EXPLANATION_DIVIDER } from "./argument-context";
import {
	App,
	Component,
	MarkdownRenderer,
	Notice,
	Scope,
	setIcon,
} from "obsidian";

import { ANNOTATION_COLORS, annotationColorLabel, type AnnotationColorChoice, type AnnotationColorMeanings } from "./colors";
import type { AnnotationService } from "./annotation-service";
import { listedExcerpt } from "./excerpt";
import { annotationDisplayText } from "./markdown-selection";
import { bilingualDescription, isTranslationPath, quoteLabel } from "./bilingual";
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
	historical?: AnnotationRecord[];
	colorMeanings?: Readonly<AnnotationColorMeanings>;
	onArchive: (record: AnnotationRecord) => Promise<void>;
	onStudyTopic?: (topic:string, path:string, passage?: TopicPassage) => void;
	onOpenExcerpt?: (record: AnnotationRecord) => void;
	onClose?: () => void;
}

function displayError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class AnnotationPopover extends Component {
	private readonly app: App;
	private readonly service: AnnotationService;
	private readonly anchorRect: DOMRect;
	private readonly selection?: AnnotationSelection;
	private record?: AnnotationRecord;
	private readonly historical: AnnotationRecord[];
	private readonly colorMeanings?: Readonly<AnnotationColorMeanings>;
	private readonly onArchive: (record: AnnotationRecord) => Promise<void>;
	private readonly onStudyTopic?: (topic:string, path:string, passage?: TopicPassage)=>void;
	private readonly onOpenExcerpt?: (record: AnnotationRecord) => void;
	private readonly onClose?: () => void;
	private element: HTMLDivElement | null = null;
	private cancelGeneration: (() => void) | null = null;
	private generationVersion = 0;
	private guideController?: AbortController;
	private closed = true;
	private saving = false;
	private outsideListener: ((event: PointerEvent) => void) | null = null;
	private keyListener: ((event: KeyboardEvent) => void) | null = null;
	private saveScope: Scope | null = null;
	private resizeListener: (() => void) | null = null;
	private dragMoveListener: ((event: PointerEvent) => void) | null = null;
	private dragEndListener: ((event: PointerEvent) => void) | null = null;
	private manualPosition: { left: number; top: number } | null = null;

	constructor(options: AnnotationPopoverOptions) {
		super();
		this.app = options.app;
		this.service = options.service;
		this.anchorRect = options.anchorRect;
		this.colorMeanings = options.colorMeanings;
		this.selection = options.selection;
		this.record = options.record;
		this.historical = [...(options.record ? [options.record] : []), ...(options.historical || [])];
		this.onArchive = options.onArchive;
		this.onStudyTopic = options.onStudyTopic;
		this.onOpenExcerpt = options.onOpenExcerpt;
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
				"aria-label": "批注",
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
		this.renderForm();
	}

	close(): void {
		this.guideController?.abort();
		this.clearSaveScope();
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

	requestClose(): boolean {
		if (this.saving) return false;
		if (
			this.element?.dataset.dirty === "true"
			&& !window.confirm("存在尚未保存的批注，确定取消吗？")
		) {
			return false;
		}
		this.close();
		return true;
	}

	private renderForm(): void {
		this.guideController?.abort();
		this.guideController = undefined;
		const element = this.reset();
		const baseline = this.record, source = baseline || this.selection;
		if (!source) return;
		const pdf = Boolean(source.pdfExcerpt);
		const pending = baseline?.archiveStatus === "pending";
		const header = element.createDiv({ cls: "agent-annotation-header", attr: { "data-agent-drag-handle": "true" } });
		const title = header.createDiv();
		const quote = pdf ? source.selectedText : annotationDisplayText(source.selectedText);
		title.createEl("strong", { text: quote, attr: { title: quote } });
		title.createSpan({ text: pdf ? `PDF · 第 ${source.pdfExcerpt!.page} 页` : quoteLabel(source) });
		const close = header.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "关闭" } });
		setIcon(close, "x");
		close.addEventListener("click", () => this.requestClose());
		header.addEventListener("pointerdown", event => this.startDragging(event));
		if (this.selection?.linkSelectionExpanded) element.createDiv({ cls: "agent-annotation-caption", text: "已选取完整的链接或格式文字" });

		const records = [baseline, ...this.historical].filter((r): r is AnnotationRecord => Boolean(r));
		const distinct = records.filter((r, i) => records.findIndex(other => other.id === r.id && other.annotationPath === r.annotationPath) === i);
		if (distinct.length > 1) {
			const label = element.createEl("label", { cls: "agent-annotation-history" });
			label.createSpan({ text: "已有多条记录" });
			const picker = label.createEl("select");
			distinct.forEach((record, i) => {
				const content = [listedExcerpt(record) ? "摘录" : "", record.color ? ANNOTATION_COLORS[record.color] : "", record.manualText ? "备注" : "", record.aiText ? "AI" : ""].filter(Boolean).join(" · ");
				picker.createEl("option", { text: `${i + 1}. ${content || "批注"}`, attr: { value: String(i) } });
			});
			picker.value = "0";
			picker.addEventListener("change", () => {
				if (this.saving || (element.dataset.dirty === "true" && !window.confirm("放弃当前未保存的修改？"))) { picker.value = "0"; return; }
				this.stopGeneration();
				this.record = distinct[Number(picker.value)];
				this.renderForm();
			});
		}

		const note = element.createEl("textarea", { cls: "agent-annotation-editor", attr: { rows: "2", placeholder: "写下个人备注…", "aria-label": "个人备注", maxlength: "10000" } });
		note.value = baseline?.manualText || "";
		const actions = element.createDiv({ cls: "agent-annotation-actions" });
		let excerpt = baseline ? listedExcerpt(baseline) : pdf;
		const canList = !pdf && (Boolean(baseline?.excerpt) || Boolean(this.selection?.sourceRevision && (!baseline || baseline.sourceAnchor)));
		const list = canList ? actions.createEl("button", { attr: { type: "button" } }) : undefined;
		const browse = excerpt && baseline && this.onOpenExcerpt ? actions.createEl("button", { text: "查看摘录", attr: { type: "button" } }) : undefined;
		if (!pdf && this.onStudyTopic) {
			const learn = actions.createEl("button",{text:"学习这个概念",attr:{type:"button"}});
			learn.onclick = () => {
				const at = baseline?.sourceAnchor?.start ?? this.selection?.sourceStart;
				const digest = baseline?.excerpt?.digest || this.selection?.sourceRevision?.digest || (source.bilingual && source.bilingual.digests[source.bilingual.language]);
				const passage = at !== undefined && digest ? { source: source.sourcePath, at: String(at), digest, quote: source.selectedText.slice(0,1200) } : undefined;
				if (this.requestClose()) this.onStudyTopic?.(quote.slice(0,160), source.sourcePath, passage);
			};
		}
		const detail = !pdf ? actions.createEl("button", { text: baseline?.aiText ? "AI 解释 ▾" : "AI 解释", attr: { type: "button", "aria-expanded": "false" } }) : undefined;
		const explanationPanel = element.createDiv({ cls: "agent-annotation-explanation" });
		explanationPanel.hidden = !baseline?.aiText;
		detail?.setAttribute("aria-expanded",String(!explanationPanel.hidden));
		let ai: HTMLTextAreaElement | undefined, generate: HTMLButtonElement | undefined;
		let question: HTMLInputElement | undefined, expand: HTMLButtonElement | undefined;
		let preview: HTMLDivElement | undefined, editAI: HTMLButtonElement | undefined;
		let editingAI = false, renderedAI = "", showContext = false;
		if (!pdf) {
			question = explanationPanel.createEl("input",{type:"text",placeholder:"对这段话有什么疑问？",attr:{"aria-label":"批注提问",maxlength:"1200"}});
			ai = explanationPanel.createEl("textarea", { cls: "agent-annotation-editor", attr: { rows: "4", maxlength: "24000", "aria-label": "AI 解释", placeholder: "生成后可在此修改解释" } });
			ai.value = baseline?.aiText || "";
			ai.hidden = true;
			preview = explanationPanel.createDiv({ cls: "agent-annotation-ai-preview markdown-rendered" });
			const aiActions = explanationPanel.createDiv({ cls: "agent-annotation-actions" });
			editAI = aiActions.createEl("button", { text: "编辑解释", attr: { type: "button" } });
			expand = aiActions.createEl("button",{text:"展开上下文解释",attr:{type:"button"}});
			generate = aiActions.createEl("button", { text: ai.value ? "重新生成" : "生成解释", attr: { type: "button" } });
		}
		const guide = !pdf ? actions.createEl("button", { text: "从这条批注开始带读", attr: { type: "button" } }) : undefined;
		const startGuide = async () => {
			if (this.guideController) return;
			const controller = this.guideController = new AbortController();
			refresh();
			showMessage("正在打开这篇论文的批注分支…");
			try {
				const record = this.record && element.dataset.dirty !== "true" ? this.record : await persistDraft(true);
				this.record = record;
				controller.signal.throwIfAborted();
				await this.service.guideFromAnnotation(record, question?.value || "", ai?.value || "", controller.signal, note.value, retryProfile.value || this.service.defaultExplanationProfileId());
				this.close();
			} catch (error) {
				if (!controller.signal.aborted) showMessage(displayError(error));
			} finally {
				if (this.guideController === controller) this.guideController = undefined;
				if (!this.closed) refresh();
			}
		};
		guide?.addEventListener("click", () => void startGuide());
		const info = element.createDiv({ cls: "agent-annotation-caption", attr: { role: "status" } });
		info.hidden = true;
		const showMessage = (message: string) => { info.hidden = !message; info.setText(message); this.position(); };
		if (baseline || source.bilingual) {
			const details = element.createEl("details", { cls: "agent-annotation-details" });
			details.createEl("summary", { text: source.bilingual ? "来源与原文" : "更多" });
			if (source.bilingual) {
				details.createEl("p", { text: bilingualDescription(source.bilingual) });
				if (source.bilingual.english) details.createEl("pre", { text: source.bilingual.english.text });
			}
			if (baseline) {
				if (baseline.aiProvider) details.createEl("p", { text: `生成记录 · ${baseline.aiProvider} ${baseline.aiModel}${baseline.aiEdited ? " · 已人工修改" : ""}` });
				const open = details.createEl("button", { text: "打开批注文档", attr: { type: "button" } });
				open.addEventListener("click", () => { if (this.requestClose()) void this.service.openAnnotationDocument(baseline).catch(error => new Notice(displayError(error))); });
				for (const target of baseline.archiveTargets) {
					const link = details.createEl("button", { text: target.split("/").pop(), attr: { type: "button" } });
					link.addEventListener("click", () => void this.service.openArchiveTarget(baseline, target).catch(error => new Notice(displayError(error))));
				}
				if (baseline.archiveError) details.createEl("p", { text: baseline.archiveError });
				if (baseline.aiText && !baseline.bilingual && !isTranslationPath(baseline.sourcePath) && !excerpt && !pending && baseline.archiveStatus !== "completed") {
					const archive = details.createEl("button", { text: baseline.archiveStatus === "failed" ? "重新归档" : "归档", attr: { type: "button" } });
					archive.addEventListener("click", () => { if (this.requestClose()) void this.onArchive(baseline); });
				}
			}
		}

		let color: AnnotationColorChoice = baseline?.color || "none", generated: AnnotationExplanation | undefined;
		let generating = false;
		const footer = element.createDiv({ cls: "agent-annotation-footer" });
		const palette = footer.createDiv({ cls: "agent-annotation-colors", attr: { role: "group", "aria-label": "标注颜色" } });
		const buttons = new Map<AnnotationColorChoice, HTMLButtonElement>();
		if (!pdf) {
			const tooltip = palette.createSpan({ cls: "agent-annotation-color-tooltip", attr: { "aria-hidden": "true" } });
			tooltip.hidden = true;
			let hovered = "", focused = "";
			const updateTooltip = () => {
				const label = hovered || focused;
				tooltip.setText(label);
				tooltip.hidden = !label;
			};
			for (const key of Object.keys({ none: "", ...ANNOTATION_COLORS }) as AnnotationColorChoice[]) {
				const label = annotationColorLabel(key, this.colorMeanings);
				const button = palette.createEl("button", { attr: { type: "button", "aria-label": label, "data-color": key } });
				button.addEventListener("mouseenter", () => { hovered = label; updateTooltip(); });
				button.addEventListener("mouseleave", () => { hovered = ""; updateTooltip(); });
				button.addEventListener("focus", () => {
					if (button.matches(":focus-visible")) { focused = label; updateTooltip(); }
				});
				button.addEventListener("blur", () => { focused = ""; updateTooltip(); });
				buttons.set(key, button);
				button.addEventListener("click", () => { color = key; refresh(); });
			}
		}
		const save = footer.createEl("button", { cls: "mod-cta", text: "保存", attr: { type: "button" } });
		const refreshExplanation = () => {
			if (!ai || !preview || !editAI) return;
			ai.hidden = !editingAI;
			preview.hidden = editingAI || !ai.value;
			editAI.hidden = !ai.value && !editingAI;
			editAI.disabled = this.saving || generating || pending === true;
			editAI.setText(editingAI ? "预览解释" : "编辑解释");
			if (!explanationPanel.hidden && !preview.hidden && renderedAI !== ai.value) {
				renderedAI = ai.value;
				preview.empty();
				const [brief, ...rest] = ai.value.split(EXPLANATION_DIVIDER);
				void MarkdownRenderer.render(this.app, brief, preview, source.sourcePath, this);
				if (rest.length) {
					const section = preview.createEl("details");
					section.open = showContext;
					section.createEl("summary", { text: "查看上下文解释" });
					const context = rest.join(EXPLANATION_DIVIDER);
					const divider = "\n\n原文依据\n";
					const at = context.lastIndexOf(divider);
					const rows = at < 0 ? [] : context.slice(at + divider.length).split(/\n\n(?=\[段 )/).map(row => /^\[段 (\d+) 句 \d+\] ([\s\S]+)$/.exec(row));
					const linked = rows.length > 0 && rows.every(row => row);
					void MarkdownRenderer.render(this.app, linked ? context.slice(0,at) : context, section.createDiv(), source.sourcePath, this);
					if (linked) {
						section.createEl("strong", {text: "原文依据"});
						for (const row of rows) {
							const quote = row![2].trim();
							const button = section.createEl("button", {cls:"rar-quote-link",text: row![0], attr:{type:"button",title:"回到引句所在段落"}});
							button.onclick = () => void this.service.openContextQuote(source, Number(row![1]), quote).catch(error => showMessage(displayError(error)));
						}
					}
				}
			}
		};
		const refresh = () => {
			const hasChanges = note.value !== (baseline?.manualText || "") || (ai?.value || "") !== (baseline?.aiText || "")
				|| generated !== undefined || color !== (baseline?.color || "none") || excerpt !== (baseline ? listedExcerpt(baseline) : false);
			element.dataset.dirty = String(hasChanges && (Boolean(baseline) || !pdf || Boolean(note.value)));
			const guiding = Boolean(this.guideController);
			if (guide) {
				guide.disabled = Boolean(this.saving || generating || guiding || pending);
				guide.setText(guiding ? "正在打开分支…" : "从这条批注开始带读");
			}
			const locked = this.saving || pending || guiding;
			note.disabled = Boolean(locked);
			if (ai) ai.disabled = Boolean(locked || generating || (!generated && !baseline?.aiText));
			if (expand) { expand.hidden = !ai?.value || ai.value.includes(EXPLANATION_DIVIDER); expand.disabled = Boolean(locked || generating); }
			if (generate) { generate.disabled = Boolean(locked || (!generating && !this.selection && !baseline)); generate.setText(generating ? "停止生成" : ai?.value ? "重新生成" : "生成解释"); }
			if (list) {
				list.disabled = Boolean(locked);
				list.setText(excerpt ? "已收录" : "收录摘录");
				list.setAttribute("aria-pressed", String(excerpt));
			}
			for (const [key, button] of buttons) { button.disabled = Boolean(locked); button.setAttribute("aria-pressed", String(key === color)); }
			save.disabled = Boolean(locked || generating || (!hasChanges && !(pdf && !baseline)));
			refreshExplanation();
		};
		note.addEventListener("input", refresh);
		ai?.addEventListener("input", refresh);
		list?.addEventListener("click", () => { excerpt = !excerpt; refresh(); });
		browse?.addEventListener("click", () => { if (this.requestClose()) this.onOpenExcerpt?.(baseline!); });
		editAI?.addEventListener("click", () => { editingAI = !editingAI; refreshExplanation(); if (editingAI) ai?.focus(); this.position(); });
		detail?.addEventListener("click", () => {
			explanationPanel.hidden = !explanationPanel.hidden;
			detail.setAttribute("aria-expanded", String(!explanationPanel.hidden));
			refreshExplanation();
			this.position();
		});
		let traces = [...(baseline?.paperTraces || [])];
		const explain = async (deep: boolean) => {
			if (!ai) return;
			if (generating) { this.stopGeneration(); generating = false; showMessage("已停止生成"); refresh(); return; }
			if (!deep && ai.value.trim() && !window.confirm("重新生成会替换面板中的解释，确定继续？")) return;
			const version = ++this.generationVersion;
			generating = true; showMessage("正在生成解释…"); refresh();
			const isCurrent = () => !this.closed && version === this.generationVersion;
			try {
				const context = baseline && (baseline.bilingual || !this.selection?.bilingual) ? await this.service.getRecordExplanationContext(baseline) : this.selection!;
				if (!isCurrent()) return;
				const explanation = await this.service.generateExplanation(context, cancel => { if (isCurrent()) this.cancelGeneration = cancel; else cancel(); },{profileId:retryProfile?.value,question:question?.value,depth:deep?"context":"brief",gpt:readGptChoices(deep)});
				if (!isCurrent()) return;
				if (explanation.trace) traces = [...traces, explanation.trace];
				generated = explanation;
				const asked = question?.value.trim();
				const answer = (asked ? "**提问** " + asked + "\n\n" : "") + explanation.text;
				ai.value = deep ? ai.value + EXPLANATION_DIVIDER + answer : answer;
				showContext = deep;
				generated = { ...explanation, text: ai.value };
				showMessage("解释已生成，可修改后保存");
			} catch (error) {
				if (isCurrent()) {
					showMessage(displayError(error));
					if (/模型|连接|CLI|超时|认证|凭据|API|network|timeout/i.test(displayError(error))) {
						info.createEl("button",{text:"检查批注模型"}).onclick=()=>this.service.openModelSettings();
					}
				}
			} finally {
				if (isCurrent()) { generating = false; this.cancelGeneration = null; refresh(); }
			}
		};
		const gptPanel = explanationPanel.createDiv({ cls: "agent-annotation-gpt-options" });
		const advanced = explanationPanel.createEl("details");
		advanced.createEl("summary", {text: "更多模型设置"});
		const retryProfile = advanced.createEl("select", { attr: { "aria-label": "本次批注使用的模型" } });
		retryProfile?.createEl("option", { value: "", text: "使用批注默认模型" });
		const profiles = this.service.explanationProfiles?.() || [];
		for (const profile of profiles) retryProfile?.createEl("option", { value: profile.id, text: profile.name + " · " + profile.model });
		const tuning = advanced.createDiv({ cls: "agent-annotation-gpt-options" });
		const selectField = (label: string, parent = tuning) => {
			const field = parent.createEl("label");
			field.createSpan({ text: label });
			return field.createEl("select", { attr: { "aria-label": label } });
		};
		const model = selectField("GPT 模型", gptPanel), speed = selectField("处理速度");
		const brief = selectField("简短释义思考强度"), expanded = selectField("展开解释思考强度");
		const searchLabel = gptPanel.createEl("label");
		const search = searchLabel.createEl("input", { type: "checkbox" });
		searchLabel.createSpan({ text: "本次允许 OpenAI 联网搜索" });
		const fill = (select: HTMLSelectElement, values: readonly string[], preferred: string, labels: Record<string,string> = {}) => {
			select.empty();
			for (const value of values) select.createEl("option", { value, text: labels[value] || value });
			select.value = preferred;
		};
		const syncModel = () => {
			const active = supportsGptAnnotations(model.value);
			tuning.hidden = !active;
			searchLabel.hidden = !active;
			const { speeds, efforts } = gptOptions(model.value);
			fill(speed, speeds, speeds.includes(speed.value) ? speed.value : "default", { default: "标准", fast: "Fast", ultrafast: "Ultrafast" });
			fill(brief, efforts, efforts.includes(brief.value) ? brief.value : "medium");
			fill(expanded, efforts, efforts.includes(expanded.value) ? expanded.value : "high");
		};
		const syncProfile = () => {
			const id = retryProfile?.value || this.service.defaultExplanationProfileId?.();
			const profile = profiles.find(p => p.id === id);
			gptPanel.hidden = profile?.type !== "openai";
			tuning.hidden = gptPanel.hidden;
			if (!profile || gptPanel.hidden) return;
			fill(model, [...new Set([profile.model, ...GPT_ANNOTATION_MODELS])], profile.model);
			syncModel();
		};
		model.onchange = syncModel;
		retryProfile?.addEventListener("change", syncProfile);
		syncProfile();
		const readGptChoices = (deep: boolean): GptChoices | undefined => gptPanel.hidden || !supportsGptAnnotations(model.value)
			? undefined : { model: model.value, speed: speed.value, effort: deep ? expanded.value : brief.value, search: search.checked };
		generate?.addEventListener("click",()=>void explain(false)); expand?.addEventListener("click",()=>void explain(true));
		const persistDraft = (forGuide = false) => {
			const draft: AnnotationDraft = { manualText: note.value };
			if (!pdf) {
				draft.color = color;
				if (canList && (!baseline || excerpt !== listedExcerpt(baseline))) draft.excerptListed = excerpt;
				if (generated || (ai?.value || "") !== (baseline?.aiText || "")) draft.aiText = ai?.value || "";
				if (generated) Object.assign(draft, { paperTraces: traces, aiProvider: generated.provider, aiModel: generated.model, aiCli: generated.cli, aiEdited: draft.aiText !== generated.text });
			}
			return this.record ? this.service.updateAnnotation(this.record, draft, this.selection) : this.service.saveSelectionAnnotation(this.selection!, draft, forGuide);
		};
		const submit = async () => {
			if (this.closed || this.saving || save.disabled) return;
			this.saving = true; refresh();
			try {
				const record = await persistDraft();
				if (this.closed) return;
				this.record = record;
				const historyIndex = this.historical.findIndex(item => item.id === record.id && item.annotationPath === record.annotationPath);
				if (historyIndex >= 0) this.historical[historyIndex] = record;
				this.saving = false;
				this.renderForm();
				new Notice("批注已保存");
			} catch (error) {
				if (!this.closed) showMessage(displayError(error));
			} finally {
				this.saving = false;
				if (element.contains(save)) refresh();
			}
		};
		save.addEventListener("click", () => void submit());
		this.bindSaveScope(submit);
		refresh();
		this.position();
	}

	private stopGeneration(): void {
		this.generationVersion++;
		this.cancelGeneration?.();
		this.cancelGeneration = null;
	}

	private bindSaveScope(submit: () => Promise<unknown>): void {
		this.clearSaveScope();
		const scope = this.saveScope = new Scope(this.app.scope);
		scope.register(["Mod"], "Enter", () => {
			if (!this.closed) void submit();
			return false;
		});
		this.app.keymap.pushScope(scope);
	}

	private clearSaveScope(): void {
		if (this.saveScope) this.app.keymap.popScope(this.saveScope);
		this.saveScope = null;
	}

	private reset(): HTMLDivElement {
		this.clearSaveScope();
		if (!this.element) throw new Error("批注小窗尚未打开");
		this.element.empty();
		this.element.dataset.dirty = "false";
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
			const width = Math.min(352, window.innerWidth - margin * 2);
			this.element.style.width = `${Math.max(0, width)}px`;
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
