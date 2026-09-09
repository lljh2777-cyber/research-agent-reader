import type { AcquisitionBackend, DownloadContext } from "./service";
import type { AcquisitionRequest, AcquisitionCandidate, ResolvedIdentity, PdfArtifact, PdfSnapshot } from "./contracts";
import type { PdfArtifactStore } from "./file-storage";
import { IdentityResolver } from "./identity-resolver";
import { PmcProvider } from "./pmc-provider";
import { SourceError } from "./errors";
import { validatePdf, type PdfLoader, defaultPdfLoader } from "./file-validator";
import type { SourceTransport } from "./transport";

export class PmcAcquisitionBackend implements AcquisitionBackend {
	readonly mode = "production" as const;
	private resolver: IdentityResolver; private provider: PmcProvider;
	constructor(private transport: SourceTransport, readonly files: PdfArtifactStore, private pdfLoader: PdfLoader = defaultPdfLoader) { this.resolver = new IdentityResolver(transport); this.provider = new PmcProvider(transport); }
	resolve(request: AcquisitionRequest, signal: AbortSignal) { return this.resolver.resolve(request.input, signal); }
	discover(request: AcquisitionRequest, signal: AbortSignal, identity?: ResolvedIdentity) { if (!identity) throw new SourceError("missing_identity", "获取缺少论文身份"); return this.provider.discover(request, identity, signal); }
	async download(candidate: AcquisitionCandidate, signal: AbortSignal, progress: (received: number, total?: number) => void, context?: DownloadContext): Promise<PdfArtifact> {
		if (!context?.identity || !candidate.pmc) throw new SourceError("missing_identity", "下载缺少已核对的候选");
		const url = await this.provider.refresh(candidate, context.identity, context.request, signal);
		const writer = await this.files.beginArtifact(context.attemptId);
		try { await this.transport.download(url, signal, writer, progress); signal.throwIfAborted(); const artifact = await writer.finish();
			if (artifact.md5 !== candidate.pmc.md5) throw new SourceError("checksum_mismatch", "PDF 与 PMC 清单的校验值不一致，请重新查询来源"); return artifact;
		} finally { await writer.close(); }
	}
	async verify(_request: AcquisitionRequest, signal: AbortSignal, artifact?: PdfArtifact, identity?: ResolvedIdentity) {
		if (!artifact || !identity) throw new SourceError("missing_artifact", "缺少完整 PDF 文件或论文身份");
		return validatePdf(await this.files.readArtifact(artifact), identity, signal, this.pdfLoader);
	}
	async validateSnapshot(snapshot: PdfSnapshot): Promise<void> { await this.files.readArtifact(snapshot.artifact); }
	readSnapshot(snapshot: PdfSnapshot): Promise<Uint8Array> { return this.files.readArtifact(snapshot.artifact); }
}
