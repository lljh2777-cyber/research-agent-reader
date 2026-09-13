import { FileSystemAdapter, Modal, setIcon, type App } from "obsidian";
import { chooseSystemSource, listVaultSources, vaultSourcePath, type SourceKind } from "../reading/source-picker";

export class VaultSourcePicker extends Modal {
	private closed = false;
	private selected?: { path: string; directory: boolean };
	constructor(app: App, private root: string, private kind: SourceKind, private choose: (path: string) => void) { super(app); }
	onOpen(): void {
		this.modalEl.addClass("reading-modal", "reading-vault-source-modal"); this.titleEl.setText("从 Vault 选择来源");
		this.contentEl.createEl("p", { cls: "reading-modal-intro", text: this.kind === "code" ? "展开目录选择 Python/R 文件，或将整个文件夹选为代码项目。" : this.kind === "pdf" ? "展开目录，选择 PDF 文件。" : this.kind === "structured" ? "展开 papers 目录，选择已保存的 JATS article.md；打开时会核对 XML、正文映射与图像。" : "展开目录，选择 article.md；打开时会继续验证 MinerU 包。" });
		const tree = this.contentEl.createDiv("reading-source-tree"); tree.setAttribute("aria-label", "Vault 目录结构");
		const footer = this.contentEl.createDiv("reading-source-picker-footer"); const location = footer.createEl("small", { text: "尚未选择来源", attr: { role: "status" } });
		const confirm = footer.createEl("button", { text: "使用所选来源", cls: "mod-cta" }); confirm.disabled = true;
		confirm.onclick = () => { if (!this.selected) return; const value = vaultSourcePath(this.root, this.selected.path); this.close(); this.choose(value); };
		const select = (filename: string, directory: boolean, target: HTMLElement) => {
			this.selected = { path: filename, directory }; tree.querySelectorAll(".is-selected").forEach(el => { el.classList.remove("is-selected"); el.setAttribute("aria-pressed", "false"); });
			target.addClass("is-selected"); target.setAttribute("aria-pressed", "true"); location.textContent = (directory ? "项目文件夹：" : "文件：") + (filename || this.app.vault.getName()); location.title = vaultSourcePath(this.root, filename); confirm.disabled = false;
		};
		const directory = (parent: HTMLElement, filename: string, name: string, open = false) => {
			const details = parent.createEl("details", { cls: "reading-source-directory" }); details.dataset.sourceDirectory = filename; const summary = details.createEl("summary");
			setIcon(summary.createSpan("reading-source-folder-icon"), "folder"); summary.createSpan({ text: name }); summary.title = filename || this.root;
			if (this.kind === "code") { const pick = summary.createEl("button", { text: "选为项目", cls: "reading-source-pick-folder", attr: { "aria-label": "选择项目文件夹：" + (filename || this.app.vault.getName()), "aria-pressed": "false" } }); pick.onclick = event => { event.preventDefault(); event.stopPropagation(); select(filename, true, pick); }; }
			const children = details.createDiv("reading-source-children"); let loaded = false, loading = false;
			const load = async () => {
				if (!details.open || loaded || loading || this.closed) return; loading = true; children.empty(); children.createEl("small", { text: "正在读取目录…" });
				try {
					const entries = await listVaultSources(this.root, filename, this.kind); if (this.closed) return; children.empty(); loaded = true;
					for (const entry of entries) {
						if (entry.directory) directory(children, entry.path, entry.name);
						else { const file = children.createEl("button", { cls: "reading-source-file", attr: { "aria-pressed": "false", "data-source-path": entry.path } }); setIcon(file.createSpan("reading-source-file-icon"), this.kind === "code" ? "file-code" : "file-text"); file.createSpan({ text: entry.name }); file.title = entry.path; file.onclick = () => select(entry.path, false, file); file.ondblclick = () => { select(entry.path, false, file); confirm.click(); }; }
					}
					if (!entries.length) children.createEl("small", { text: "此目录没有可选文件或子目录" });
				} catch (error) { if (!this.closed) children.setText(String(error) + "；收起再展开可重试。"); }
				finally { loading = false; }
			}; details.ontoggle = () => { void load(); }; details.open = open; if (open) void load();
		}; directory(tree, "", this.app.vault.getName(), true);
	}
	onClose(): void { this.closed = true; this.contentEl.empty(); }
}

/** Shared by new sessions and source relocation. Picking never starts a model request. */
export class ReadingSourceLocation {
	readonly input: HTMLInputElement;
	private buttons: HTMLButtonElement[] = [];
	private folder: HTMLButtonElement;
	private note: HTMLElement;
	private picker?: VaultSourcePicker;
	private revision = 0;
	private disposed = false;
	constructor(private app: App, private parent: HTMLElement, private kind: () => SourceKind) {
		parent.addClass("reading-source-location"); const label = parent.createEl("label", { cls: "reading-field", text: "原文位置" });
		this.input = label.createEl("input", { attr: { "aria-label": "原文位置", spellcheck: "false" } });
		const actions = parent.createDiv("reading-source-location-actions");
		const button = (text: string, icon: string, action: () => void) => { const b = actions.createEl("button", { attr: { type: "button" } }); setIcon(b.createSpan(), icon); b.createSpan({ text }); b.onclick = action; this.buttons.push(b); return b; };
		button("本机文件", "file-search", () => { void this.native(false); });
		this.folder = button("本机文件夹", "folder-open", () => { void this.native(true); });
		button("从 Vault 选择", "vault", () => {
			try { this.picker?.close(); const revision = ++this.revision;
				this.picker = new VaultSourcePicker(app, this.root(), this.kind(), value => { if (revision === this.revision && !this.disposed) this.set(value); }); this.picker.open();
			} catch (error) { this.note.textContent = String(error); }
		}); this.note = parent.createEl("small", { cls: "reading-source-location-note", attr: { role: "status" } }); this.refresh();
	}
	private root(): string { const adapter = this.app.vault.adapter; if (!(adapter instanceof FileSystemAdapter)) throw new Error("来源选择需要桌面文件系统"); return adapter.getBasePath(); }
	private set(value: string): void { this.input.value = value; this.input.dispatchEvent(new Event("input", { bubbles: true })); this.note.textContent = "已选择来源；打开时会核对内容。"; }
	refresh(): void {
		this.revision++; this.picker?.close(); this.folder.hidden = this.kind() !== "code";
		this.input.placeholder = this.kind() === "code" ? "Python/R 文件或项目目录的完整路径" : this.kind() === "pdf" ? "PDF 完整路径或 Vault 内的相对路径" : "papers/<citekey>/article.md 或完整路径";
		this.note.textContent = "可手动输入，也可通过按钮选择。";
	}
	private async native(directory: boolean): Promise<void> {
		const revision = ++this.revision, kind = this.kind(); this.buttons.forEach(b => { b.disabled = true; }); this.note.textContent = "请在系统窗口中选择来源…";
		try { const value = await chooseSystemSource(kind, directory, this.input.value, this.root()); if (this.disposed || revision !== this.revision) return; if (value) this.set(value); else this.note.textContent = "已取消选择，原路径保留。"; }
		catch (error) { if (!this.disposed && revision === this.revision) this.note.textContent = String(error); }
		finally { this.buttons.forEach(b => { b.disabled = false; }); }
	}
	dispose(): void { this.disposed = true; this.revision++; this.picker?.close(); }
}
