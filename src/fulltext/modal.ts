import { Modal, Notice, type App } from "obsidian";
import { acquisitionActive, acquisitionRetryable, decodeIdentity, parseAcquisitionInput, PHASE_LABELS, type AcquisitionRequest, type DemoScenario, type ResolvedIdentity } from "./contracts";
import type { AcquisitionService } from "./service";
import type { TaskRun } from "../types/contracts";
import { identityRelation } from "../papers/identity";

export class FulltextAcquisitionModal extends Modal {
	private unsubscribe?: () => void;
	private jobsEl?: HTMLElement;
	private closed = false;
	private busy = false;
	private unsubscribeRuns?:()=>void;
	private readonly confirmedIdentity?: ResolvedIdentity;
	constructor(app: App, readonly service: AcquisitionService, private selectedId?: string, private afterClose?: () => void, private openPdf?: (id: string) => Promise<void>, private intake?:{open(id:string):Promise<void>;save?(id:string):Promise<void>;jats?(id:string):Promise<void>;runs():TaskRun[];subscribe(listener:()=>void):()=>void;openRun(run:TaskRun):void}, identity?: ResolvedIdentity) { super(app); this.confirmedIdentity = identity && decodeIdentity(identity); }
	onOpen(): void {
		this.closed = false; this.modalEl.addClass("rar-fulltext-modal");
		this.setTitle(this.service.mode === "demo" ? "全文获取 · 流程演示" : "获取论文全文");
		const intro = this.service.mode === "demo" ? "开发演示使用虚构论文和模拟进度。仅保存演示记录，不下载文件、不调用模型，也不写入文献库。" : "输入论文标识或官方链接，先识别论文，再获取可用全文。此功能不需要模型配置。";
		this.contentEl.createEl("p", { text: intro, cls: "rar-fulltext-intro" });
		const label = this.contentEl.createEl("label", { text: "DOI、PMID、PMCID 或论文链接", cls: "rar-fulltext-input-label" });
		const input = label.createEl("input", { type: "text", attr: { placeholder: "10.xxxx/…、PMID:… 或 PMC…", "aria-label": "论文标识", maxlength: "1024" } });
		if (this.service.mode === "demo") input.value = "10.0000/fulltext-demo";
		if (this.confirmedIdentity) {
			input.value = Object.values(this.confirmedIdentity.identifiers)[0]!; input.disabled = true;
			this.contentEl.createEl("p", { text: "已确认文献：" + this.confirmedIdentity.title + "。沿用这份书目信息，选择内容与版本范围后再查找全文。" });
		}
		const parsedEl = this.contentEl.createEl("p", { cls: "rar-fulltext-parsed", attr: { "aria-live": "polite" } });
		let scenario: DemoScenario = "success", versionPolicy: AcquisitionRequest["versionPolicy"] = "record_only",goal:AcquisitionRequest["goal"]="pdf",includeFigures=true;
		if (this.service.mode === "demo") {
			const selectLabel = this.contentEl.createEl("label", { text: "演示场景", cls: "rar-fulltext-input-label" });
			const select = selectLabel.createEl("select", { attr: { "aria-label": "演示场景" } });
			for (const [value, text] of [["success", "顺利完成"], ["selection", "选择候选来源"], ["failure", "来源失败"], ["conflict", "论文身份冲突"], ["no_match", "无匹配全文"]]) select.createEl("option", { value, text });
			select.addEventListener("change", () => { scenario = select.value as DemoScenario; });
		} else {
			const versionLabel = this.contentEl.createEl("label", {text: "版本范围", cls: "rar-fulltext-input-label"});
			const select = versionLabel.createEl("select", {attr: {"aria-label":"全文版本范围"}});
			select.createEl("option", {value:"record_only",text:"仅出版版本"}); select.createEl("option", {value:"record_preferred_allow_manuscript",text:"出版版本或作者接受稿"});
			select.addEventListener("change", () => { versionPolicy = select.value as AcquisitionRequest["versionPolicy"]; });
			const format=this.contentEl.createEl("label",{text:"获取内容",cls:"rar-fulltext-input-label"}).createEl("select",{attr:{"aria-label":"全文获取内容"}});format.createEl("option",{value:"pdf",text:"PDF 原文"});format.createEl("option",{value:"jats",text:"JATS XML 图文原文（无需 MinerU）"});
			const images=this.contentEl.createEl("label",{cls:"rar-jats-partial"});images.hidden=true;const box=images.createEl("input",{type:"checkbox"});box.checked=true;images.appendText("同时获取 XML 引用的同版本图片");box.onchange=()=>{includeFigures=box.checked;};format.onchange=()=>{goal=format.value as AcquisitionRequest["goal"];images.hidden=goal!=="jats";};
			this.contentEl.createEl("p", { text: "PDF 优先查询 PMC"+(this.service.unpaywallEnabled?"并启用 Unpaywall 回退。":"，可在设置中启用 Unpaywall 回退。")+"JATS 仅使用 PMC 的同版本 XML 与媒体清单。标识查询使用 Europe PMC 与 Crossref；仅支持 HTTPS 直连。", cls: "rar-fulltext-unavailable" });
		}
		const start = this.contentEl.createEl("button", { text: this.service.mode === "demo" ? "开始演示" : "查找全文", cls: "mod-cta", attr: { "data-fulltext-action": "start" } });
		const validate = () => {
			try { const parsed = parseAcquisitionInput(input.value); parsedEl.setText(`${parsed.kind.toUpperCase()} · ${parsed.value}`); start.disabled = this.busy || !this.service.available; }
			catch (error) { parsedEl.setText(input.value.trim() ? error instanceof Error ? error.message : "请输入有效 DOI、PMID、PMCID 或论文链接" : "支持 DOI、PubMed、PMC 和 Nature 文章链接"); start.disabled = true; }
		};
		input.addEventListener("input", validate); validate();
		start.addEventListener("click", () => {
			if (this.busy || start.disabled) return; this.busy = true; validate();
			const request: AcquisitionRequest = { input: parseAcquisitionInput(input.value), goal,versionPolicy,...(goal==="jats"?{includeFigures}:{}), ...(this.service.mode === "demo" ? { scenario } : {}) };
			let failure = "";
			void (this.confirmedIdentity ? this.service.startConfirmed(request, this.confirmedIdentity) : this.service.start(request)).then(job => { this.selectedId = job.id; this.renderJobs(); }).catch(error => { failure = "未能查找全文：" + String(error); }).finally(() => { this.busy = false; if (!this.closed) { validate(); if (failure) parsedEl.setText(failure); } });
		});
		this.jobsEl = this.contentEl.createDiv("rar-fulltext-jobs"); this.jobsEl.setText("正在读取获取记录…");
		this.unsubscribe = this.service.subscribe(() => this.renderJobs());
		this.unsubscribeRuns=this.intake?.subscribe(()=>this.renderJobs());
		void this.service.ready().then(() => this.renderJobs()).catch(() => { if (!this.closed) this.jobsEl?.setText("获取记录读取失败，请检查插件存储目录后重新打开插件"); start.disabled = true; });
	}
	private renderJobs(): void {
		if (this.closed || !this.jobsEl) return;
		const focus = this.jobsEl.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.fulltextKey : undefined;
		this.jobsEl.empty();
		for (const error of this.service.diagnostics) this.jobsEl.createEl("p", { text: error, cls: "rar-fulltext-error" });
		const jobs = this.service.list().filter(job => !this.confirmedIdentity || identityRelation(this.confirmedIdentity.identifiers,
			job.identity?.identifiers || job.confirmedIdentity?.identifiers || { [job.request.input.kind]: job.request.input.value }) === "same");
		this.jobsEl.createEl("h3", { text: this.confirmedIdentity ? "此文献的获取记录" : this.service.mode === "demo" ? "演示记录" : "获取记录" });
		if (this.confirmedIdentity) this.jobsEl.createEl("p", { text: "按精确文献标识筛选。继续旧记录会保留当时的来源、版本选择和书目信息；也可在上方开始新的查找。" });
		if (!jobs.length) this.jobsEl.createEl("p", { text: this.confirmedIdentity ? "此文献暂无可匹配的获取记录。" : "暂无获取记录", cls: "rar-fulltext-muted" });
		const visible = jobs.slice(0,50); const selected = jobs.find(job => job.id === this.selectedId); if (selected && !visible.some(job => job.id === selected.id)) visible.unshift(selected);
		for (const job of visible) {
			const card = this.jobsEl.createDiv({ cls: "rar-fulltext-job", attr: { "data-job-id": job.id, "data-phase": job.phase } });
			if (job.id === this.selectedId) card.addClass("is-selected");
			card.createEl("strong", { text: job.identity?.title || job.request.input.value });
			card.createEl("p",{text:job.request.goal==="jats"?"JATS XML · "+(job.request.includeFigures?"正文与图片":"仅正文"):"PDF 原文"});
			if (job.identity) {
				card.createEl("p", {text: [job.identity.authors.slice(0,6).join("; ") + (job.identity.authors.length > 6 ? ` 等 ${job.identity.authors.length} 位作者` : ""), job.identity.year].filter(Boolean).join(" · "), cls:"rar-fulltext-muted"});
				card.createEl("p", {text: Object.entries(job.identity.identifiers).filter(([,v])=>v).map(([k,v])=>k.toUpperCase()+": "+v).join(" · ")});
				for (const warning of job.identity.warnings) card.createEl("p", {text:warning,cls:"rar-fulltext-muted"});
			}
			card.createEl("span", { text: job.phase === "acquired" && job.mode === "demo" ? "演示完成" : job.phase === "acquired" && job.identityCheck === "needs_confirmation" ? "已获取，身份待核对" : PHASE_LABELS[job.phase], cls: "rar-fulltext-phase" });
			card.createEl("p", { text: job.detail });
			if (job.receivedBytes !== undefined) {
				const progress = card.createEl("progress", { attr: { "aria-label": job.mode === "demo" ? "模拟获取进度" : "全文获取进度" } }); if (job.totalBytes) { progress.max = job.totalBytes; progress.value = job.receivedBytes; }
				card.createEl("small", { text: `${job.receivedBytes} / ${job.totalBytes ?? "未知"} 字节${job.mode === "demo" ? "（模拟）" : ""}` });
			}
			if (job.error) card.createEl("p", { text: job.error, cls: "rar-fulltext-error" });
			if (job.storageWarning) card.createEl("p", { text: job.storageWarning, cls: "rar-fulltext-error", attr: { role: "alert" } });
			const pmcid = job.identity?.identifiers.pmcid || (job.request.input.kind === "pmcid" ? job.request.input.value : undefined);
			const doi = job.identity?.identifiers.doi || (job.request.input.kind === "doi" ? job.request.input.value : undefined);
			if (job.mode === "production" && (pmcid || doi)) card.createEl("a", {text: pmcid ? "PMC 官方页面" : "DOI 论文页面", href: pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/` : "https://doi.org/" + encodeURIComponent(doi!), attr:{target:"_blank",rel:"noopener noreferrer"}});
			if (!this.service.owned(job)) { card.createEl("p", { text: "其他设备的记录，仅供查看", cls: "rar-fulltext-muted" }); continue; }
			const button = (text: string, key: string, work: () => void | Promise<void>) => {
				const el = card.createEl("button", { text, attr: { "data-fulltext-action": key, "data-fulltext-key": job.id + ":" + key } });
				el.addEventListener("click", () => { el.disabled = true; void Promise.resolve().then(work).catch(() => new Notice("操作未完成，请检查任务状态")).finally(() => { el.disabled = false; }); });
			};
			if(job.phase==="awaiting_selection" && job.mode==="production")card.createEl("p",{text:job.request.goal==="jats"?"选择要获取的 JATS 版本。XML 与图片均来自此版本；失败后可重试或重新查询。":"从所选来源开始，获取失败会依次尝试下方符合版本范围的候选；身份冲突会停止。",cls:"rar-fulltext-muted"});
			if (job.phase === "awaiting_selection") for (const candidate of job.candidates) {
				if (candidate.pmc) card.createEl("p", {text: `${candidate.pmc.sourceVersionId} · ${candidate.version === "accepted_manuscript" ? "作者接受稿" : "出版版本"} · 许可：${candidate.pmc.license}${candidate.pmc.retracted ? " · 来源标记为已撤稿" : ""}`});
				if(candidate.oa)card.createEl("p",{text:`${candidate.oa.origin} · ${candidate.version==="accepted_manuscript"?"作者接受稿":"出版版本"} · ${candidate.oa.hostType==="publisher"?"出版社":"开放仓储"} · 许可：${candidate.oa.license}`});
				if(candidate.jats)card.createEl("p",{text:`${candidate.jats.sourceVersionId} · ${candidate.version==="accepted_manuscript"?"作者接受稿":"出版版本"} · 许可：${candidate.jats.license}${candidate.jats.retracted?" · 已撤稿":""}`});
				button(candidate.jats?"获取 JATS · "+candidate.jats.sourceVersionId:candidate.pmc ? "获取 PDF · " + candidate.pmc.sourceVersionId : candidate.oa?"获取 PDF · "+new URL(candidate.oa.origin).hostname:"选择 " + candidate.title, candidate.id, () => this.service.choose(job.id, candidate.id));
			}
			if (job.phase === "acquired" &&job.request.goal==="pdf"&& job.mode === "production" && this.openPdf) button("预览 PDF", "preview", () => this.openPdf!(job.id));
			if (job.phase === "acquired" &&job.request.goal==="pdf"&& job.mode === "production" && this.intake?.save) button(job.sourcePackages?.length?"查看原文保存与登记":"仅保存原文", "save-source", () => this.intake!.save!(job.id));
			if(job.phase==="acquired"&&job.request.goal==="jats"&&this.intake?.jats)button(job.sourcePackages?.length?"查看 JATS 保存与登记":"查看 XML 并保存原文","save-jats",()=>this.intake!.jats!(job.id));
			if(job.phase==="acquired"&&job.request.goal==="jats")button("重新查询 JATS 与图片","refresh-jats",async()=>{const fresh=await this.service.refreshJats(job.id);this.selectedId=fresh.id;this.renderJobs();});
			for(const key of job.sourcePackages||[])card.createEl("p",{text:`原文包：papers/${key}/${job.request.goal==="pdf"?"source.pdf":"article.md"}`});
			if (job.phase === "acquired" &&job.request.goal==="pdf"&& job.mode === "production" && this.intake) button("继续入库", "intake", () => this.intake!.open(job.id));
			if(this.intake && job.mode==="production") {
				const linked=this.intake.runs().filter(run=>run.acquisitionSource?.jobId===job.id || job.intakeRunIds?.includes(run.id));
				for(const run of linked) {card.createEl("p",{text:"关联入库："+({running:"进行中",queued:"等待中",done:"已完成",failed:"未完成",interrupted:"已中断"}[run.status]||run.status)});button("查看入库任务", "intake-"+run.id,()=>this.intake!.openRun(run));}
			}
			if (acquisitionActive(job.phase)) button("停止", "stop", () => { if (!this.service.stop(job.id)) new Notice("结果正在保存，稍后可查看完成状态"); });
			if (acquisitionRetryable(job.phase)) button("重试", "retry", () => this.service.retry(job.id));
		}
		if (jobs.length > 50) this.jobsEl.createEl("p", { text: "显示最近 50 条记录，完整记录仍保存在插件目录。" });
		if (focus) [...this.jobsEl.querySelectorAll<HTMLElement>("[data-fulltext-key]")].find(el => el.dataset.fulltextKey === focus)?.focus({ preventScroll: true });
	}
	onClose(): void { this.closed = true; this.unsubscribe?.(); this.unsubscribeRuns?.(); this.unsubscribe = undefined; this.unsubscribeRuns=undefined; this.contentEl.empty(); this.afterClose?.(); }
}
