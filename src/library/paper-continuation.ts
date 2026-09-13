import { decodeIdentity } from "../fulltext/contracts";
import { objectDigest } from "../papers/identity";
import type { PaperIntakeContext } from "./metadata-intake";
import type { LibraryReadResult } from "./reader";
import type { LibraryPaper } from "./types";

/** Details are a read projection; recheck the saved identity before opening a writer. */
export function continuationBlockReason(paper: LibraryPaper, data: LibraryReadResult): string | undefined {
	if (paper.objects.some(item => item.manualBibliography)) return "人工条目尚未核验。可重新查询书目并核对结果；不会直接按手填线索下载或关联原文。";
	if (!paper.paperId || paper.association !== "identified") return "文献身份尚未唯一确认，请先核对关联。";
	if (data.readIssues.some(issue => issue.area !== "annotations" && issue.blocksRecords !== false)) return "文献目录读取不完整，请处理读取提示后刷新。";
	const state = data.recordStates.find(record => record.paperId === paper.paperId);
	if (state?.blocked || (state?.heads.length || 0) > 1) return "书目记录损坏或存在并发决定，请先核对记录。";
	if (!paper.objects.some(item => item.kind === "record" && item.bibliography)) return "此记录未保存完整书目信息，请通过顶部“添加文献”重新查询，再从查询结果继续。";
}

export function savedPaperContext(expected: LibraryPaper, fresh: LibraryReadResult): PaperIntakeContext {
	const matches = fresh.papers.filter(paper => paper.paperId === expected.paperId);
	if (!expected.paperId || matches.length !== 1) throw new Error("文献关联已变化，请刷新后重新选择");
	const paper = matches[0], reason = continuationBlockReason(paper, fresh);
	if (reason) throw new Error(reason);
	const identity = decodeIdentity(paper.objects.find(item => item.kind === "record" && item.bibliography)!.bibliography);
	const previous = expected.objects.find(item => item.kind === "record" && item.bibliography)?.bibliography;
	if (expected.association !== "identified" || !previous || objectDigest(previous) !== objectDigest(identity)
		|| objectDigest(expected.identifiers) !== objectDigest(paper.identifiers)) throw new Error("书目信息已变化，请刷新后重新核对");
	return { identity, paperId: paper.paperId! };
}
