import { App, Modal, TFile, setIcon } from "obsidian";
import * as path from "node:path";

import {
	MAX_QUERY_IMAGE_ATTACHMENTS,
	MAX_VAULT_IMAGE_BYTES,
	VAULT_IMAGE_MIME_TYPES,
} from "../config";
import {
	normalizeVaultImageAttachment,
	normalizeVaultImageAttachments,
	type VaultImageAttachment,
} from "../query/normalization";

interface ImageReference {
	title: string;
	path: string;
	count: number;
}

interface ImagePickerItem {
	file: TFile;
	references: ImageReference[];
}

interface VaultImagePickerHost {
	buildVaultImageReferenceIndex(files: TFile[]): Map<string, ImageReference[]>;
}

export class VaultImagePickerModal extends Modal {
	private readonly plugin: VaultImagePickerHost;
	private readonly onChoose: (image: VaultImageAttachment) => void;
	private readonly selectedPaths: Set<string>;

	constructor(
		app: App,
		plugin: VaultImagePickerHost,
		onChoose: (image: VaultImageAttachment) => void,
		selectedImages: unknown = [],
	) {
		super(app);
		this.plugin = plugin;
		this.onChoose = onChoose;
		this.selectedPaths = new Set(
			normalizeVaultImageAttachments(selectedImages)
				.map((image) => image.path.toLocaleLowerCase()),
		);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("query-wiki-image-picker");
		this.modalEl?.addClass("query-wiki-image-picker-modal");
		this.setTitle("添加 Vault 图片");
		contentEl.createEl("p", {
			cls: "query-wiki-image-picker-description",
			text: `每轮最多 ${MAX_QUERY_IMAGE_ATTACHMENTS} 张。将鼠标移到图片上可查看大图和引用笔记；会话历史只保存 Vault 相对路径。`,
		});
		const toolbar = contentEl.createDiv({ cls: "query-wiki-image-picker-toolbar" });
		const search = toolbar.createEl("input", {
			cls: "query-wiki-image-picker-search",
			attr: {
				type: "search",
				placeholder: "按图片名、路径或引用笔记筛选…",
				"aria-label": "筛选 Vault 图片",
			},
		});
		const filter = toolbar.createEl("select", {
			cls: "query-wiki-image-picker-filter",
			attr: { "aria-label": "筛选图片引用状态" },
		});
		[
			["all", "全部图片"],
			["referenced", "已被引用"],
			["unreferenced", "未被引用"],
		].forEach(([value, label]) => filter.createEl("option", {
			text: label,
			attr: { value },
		}));
		const summary = contentEl.createDiv({ cls: "query-wiki-image-picker-summary" });
		const browser = contentEl.createDiv({ cls: "query-wiki-image-picker-browser" });
		const list = browser.createDiv({ cls: "query-wiki-image-picker-list" });
		const preview = browser.createEl("aside", {
			cls: "query-wiki-image-picker-preview",
			attr: { "aria-label": "图片预览与引用信息" },
		});
		const files = this.app.vault.getFiles()
			.filter((file) => Boolean(VAULT_IMAGE_MIME_TYPES[path.extname(file.path).toLowerCase()]))
			.filter((file) => Number(file.stat?.size || 0) <= MAX_VAULT_IMAGE_BYTES)
			.filter((file) => !this.selectedPaths.has(file.path.toLocaleLowerCase()))
			.sort((a, b) => Number(b.stat?.mtime || 0) - Number(a.stat?.mtime || 0));
		const referenceIndex = this.plugin.buildVaultImageReferenceIndex(files);
		const items: ImagePickerItem[] = files.map((file) => ({
			file,
			references: referenceIndex.get(file.path) || [],
		}));
		const referencedCount = items.filter((item) => item.references.length > 0).length;
		const renderPreview = (item: ImagePickerItem | null) => {
			preview.empty();
			if (!item) {
				preview.createEl("p", {
					cls: "query-wiki-image-picker-preview-empty",
					text: "没有可预览的图片。",
				});
				return;
			}
			preview.createEl("img", {
				cls: "query-wiki-image-picker-preview-image",
				attr: {
					src: this.app.vault.getResourcePath(item.file),
					alt: item.file.name,
				},
			});
			const heading = preview.createDiv({ cls: "query-wiki-image-picker-preview-heading" });
			heading.createEl("strong", { text: item.file.name });
			heading.createEl("small", {
				text: `${(Number(item.file.stat?.size || 0) / 1024 / 1024).toFixed(2)} MiB`,
			});
			preview.createEl("code", {
				cls: "query-wiki-image-picker-preview-path",
				text: item.file.path,
			});
			const referenceSection = preview.createDiv({
				cls: "query-wiki-image-picker-preview-references",
			});
			referenceSection.createEl("h4", {
				text: item.references.length
					? `引用笔记（${item.references.length}）`
					: "引用笔记",
			});
			if (!item.references.length) {
				referenceSection.createEl("p", {
					cls: "query-wiki-image-picker-reference-empty",
					text: "未在 MetadataCache 中发现 Markdown 引用。",
				});
				return;
			}
			for (const reference of item.references) {
				const row = referenceSection.createDiv({
					cls: "query-wiki-image-picker-reference-row",
				});
				const icon = row.createSpan({ cls: "query-wiki-image-picker-reference-icon" });
				setIcon(icon, "file-text");
				const note = row.createDiv({ cls: "query-wiki-image-picker-reference-note" });
				note.createEl("strong", { text: reference.title });
				note.createEl("span", { text: reference.path });
				if (reference.count > 1) {
					row.createEl("small", { text: `${reference.count} 处` });
				}
			}
		};
		const renderList = () => {
			list.empty();
			const term = search.value.trim().toLocaleLowerCase();
			const mode = filter.value || "all";
			const visible = items
				.filter((item) => {
					if (mode === "referenced" && !item.references.length) return false;
					if (mode === "unreferenced" && item.references.length) return false;
					if (!term) return true;
					const searchable = [
						item.file.name,
						item.file.path,
						...item.references.flatMap((reference) => [reference.title, reference.path]),
					].join("\n").toLocaleLowerCase();
					return searchable.includes(term);
				})
				.slice(0, 120);
			summary.setText(
				`显示 ${visible.length} / ${items.length} 张图片 · ${referencedCount} 张已被 Markdown 引用`,
			);
			if (!visible.length) {
				list.createEl("p", {
					cls: "query-wiki-image-picker-empty",
					text: "没有找到符合条件的图片。",
				});
				renderPreview(null);
				return;
			}
			renderPreview(visible[0]);
			for (const item of visible) {
				const { file, references } = item;
				const button = list.createEl("button", {
					cls: "query-wiki-image-picker-item",
					attr: { type: "button", title: file.path },
				});
				button.createEl("img", {
					cls: "query-wiki-image-picker-thumb",
					attr: {
						src: this.app.vault.getResourcePath(file),
						alt: "",
					},
				});
				const text = button.createDiv({ cls: "query-wiki-image-picker-text" });
				const title = text.createDiv({ cls: "query-wiki-image-picker-item-title" });
				title.createEl("strong", { text: file.name });
				title.createEl("small", {
					text: `${(Number(file.stat?.size || 0) / 1024 / 1024).toFixed(2)} MiB`,
				});
				text.createEl("code", { text: file.path });
				const reference = text.createDiv({ cls: "query-wiki-image-picker-item-reference" });
				if (references.length) {
					const referenceIcon = reference.createSpan();
					setIcon(referenceIcon, "file-text");
					reference.createEl("span", {
						text: references.length === 1
							? `引用：${references[0].title}`
							: `被 ${references.length} 篇笔记引用：${references[0].title} 等`,
					});
				} else {
					reference.addClass("is-unreferenced");
					reference.createEl("span", { text: "未发现 Markdown 引用" });
				}
				button.addEventListener("mouseenter", () => renderPreview(item));
				button.addEventListener("focus", () => renderPreview(item));
				button.addEventListener("click", () => {
					const attachment = normalizeVaultImageAttachment({
						path: file.path,
						name: file.name,
						size: file.stat?.size,
					});
					if (!attachment) return;
					this.close();
					this.onChoose(attachment);
				});
			}
		};
		search.addEventListener("input", renderList);
		filter.addEventListener("change", renderList);
		renderList();
		window.setTimeout(() => search.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}
