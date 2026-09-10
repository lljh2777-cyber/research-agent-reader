import { parseYaml } from "obsidian";
import type { SourceStorage } from "../sources/storage";
import { loadJatsSource } from "../sources/jats-package";
import { objectDigest } from "../papers/identity";
import { conflictingNoteIdentifiers } from "../papers/note-identity";
import { jatsEvidenceMetadata, jatsWikiSlice } from "./wiki-evidence";

/** Registration checks the same source contract as draft creation. No evidence-depth upgrade. */
export async function verifyJatsWikiSource(storage: SourceStorage, notePath: string, text: string): Promise<void> {
	const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text), meta = front && parseYaml(front[1]);
	if (!meta) return;
	const hasJatsProvenance = meta.source_manifest_digest || meta.source_projection_id || /--jats--/.test(String(meta.source_path || ""));
	if (meta.source_kind !== "jats") { if (hasJatsProvenance) throw new Error("JATS Wiki 来源类型与凭据不一致"); return; }
	const match = /^papers\/([^/]+)\/article\.md$/.exec(String(meta.source_path || "")); if (!match) throw new Error("JATS Wiki 缺少固定来源路径");
	const source = await loadJatsSource(storage, match[1]), m = source.manifest;
	if (conflictingNoteIdentifiers(m.identity, meta)) throw new Error("JATS Wiki 论文标识与原文身份不一致");
	if (notePath !== `wiki/sources/${m.citekey}.md` || meta.citekey !== m.citekey || meta.title !== m.identity.title || meta.source_manifest_digest !== m.digest
		|| meta.source_projection_id !== m.projectionId || meta.source_xml_sha256 !== source.projection.xmlSha256 || meta.source_identity_digest !== objectDigest(m.identity) || meta.source_version !== m.sourceVersionId) throw new Error("JATS Wiki 来源凭据与原文不一致");
	if (!Array.isArray(meta.source_evidence) || !meta.source_evidence.length || meta.source_evidence.length > 24) throw new Error("JATS Wiki 缺少可核验的原文证据位置");
	for (const e of meta.source_evidence) {
		const block = source.projection.blocks.find(b => b.id === e?.blockId); if (!block) throw new Error("JATS Wiki 证据块无效");
		const expected = jatsEvidenceMetadata([jatsWikiSlice(source, block.id, e.start - block.start)])[0];
		if (objectDigest(expected) !== objectDigest(e)) throw new Error("JATS Wiki 证据位置或文字摘要已变化");
	}
}
