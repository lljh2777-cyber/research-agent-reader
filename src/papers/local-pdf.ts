import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodeIdentity, PDF_MAX_BYTES } from "../fulltext/contracts";
import { pdfEnvelope, validatePdf, type PdfLoader } from "../fulltext/file-validator";
import { decodeLocalPdfSnapshot, type LocalPdfSnapshot } from "../sources/pdf-snapshot";
import { bytesDigest, type ResolvedIdentity } from "./identity";

/** Read only the explicitly selected regular file, with a bounded handle and race checks. */
export async function readLocalPdfFile(filePath: string, signal: AbortSignal): Promise<Uint8Array> {
	signal.throwIfAborted();
	if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== ".pdf") throw new Error("请选择本地 PDF 的绝对路径");
	const handle = await fs.open(filePath, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size < 16 || before.size > PDF_MAX_BYTES) throw new Error("本地 PDF 必须是 64 MiB 以内的普通文件");
		const bytes = Buffer.alloc(before.size); let offset = 0;
		while (offset < bytes.length) {
			signal.throwIfAborted();
			const read = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
			if (!read.bytesRead) throw new Error("本地 PDF 在读取时发生变化"); offset += read.bytesRead;
		}
		const tail = await handle.read(Buffer.alloc(1), 0, 1, offset), after = await handle.stat(); signal.throwIfAborted();
		if (tail.bytesRead || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("本地 PDF 在读取时发生变化");
		pdfEnvelope(bytes); return bytes;
	} finally { await handle.close(); }
}

/** No copy, upload or persistent write. The resolver's identity is an explicit input. */
export async function prepareLocalPdf(filePath: string, rawIdentity: ResolvedIdentity, signal: AbortSignal,
	options: { version?: LocalPdfSnapshot["version"]; read?: typeof readLocalPdfFile; pdfLoader?: PdfLoader } = {},
): Promise<{ path: string; bytes: Uint8Array; snapshot: LocalPdfSnapshot }> {
	signal.throwIfAborted(); const identity = decodeIdentity(rawIdentity), version = options.version || "unknown";
	const bytes = await (options.read || readLocalPdfFile)(filePath, signal); signal.throwIfAborted();
	const validation = await validatePdf(bytes, identity, signal, options.pdfLoader); signal.throwIfAborted();
	const snapshot = decodeLocalPdfSnapshot({ schemaVersion: 1, kind: "local-pdf", id: "s-" + randomUUID(), createdAt: new Date().toISOString(),
		origin: { kind: "local-file", fileName: path.basename(filePath), versionBasis: version === "unknown" ? "unspecified" : "user-declared" },
		version, identity, artifact: { byteLength: bytes.length, sha256: bytesDigest(bytes) }, validation });
	return { path: filePath, bytes, snapshot };
}

/** Resume only with a previously persisted snapshot; selecting another file cannot rebind it. */
export async function rereadLocalPdf(filePath: string, raw: LocalPdfSnapshot, signal: AbortSignal,
	read: typeof readLocalPdfFile = readLocalPdfFile,
): Promise<{ path: string; bytes: Uint8Array; snapshot: LocalPdfSnapshot }> {
	const snapshot = decodeLocalPdfSnapshot(raw), bytes = await read(filePath, signal); signal.throwIfAborted();
	if (bytes.length !== snapshot.artifact.byteLength || bytesDigest(bytes) !== snapshot.artifact.sha256) throw new Error("本地 PDF 已变化，请重新核对身份；未替换原快照");
	return { path: filePath, bytes, snapshot };
}
