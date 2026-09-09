import type { MineruReaderPackage } from "../mineru/types";
import type { JatsProjection } from "../jats/projection";
/** View capabilities, independent of any extractor's page/layout representation. */
export interface ReaderDocument {
	kind:"mineru"|"markdown"|"jats";title:string;body:string;resources:string[];issues:string[];
	capabilities:{hasText:boolean;hasFigures:boolean;hasPdf:boolean;hasPageMap:boolean;hasLayoutBoxes:boolean;};
	structured?:JatsProjection;
}
export function adaptReaderDocument(pkg:MineruReaderPackage,structured?:JatsProjection):MineruReaderPackage {
	pkg.document={kind:pkg.sourceKind,title:pkg.title,body:pkg.articleMarkdown,resources:pkg.visuals.flatMap(v=>v.memberAssetPaths),issues:pkg.issues,capabilities:{hasText:!!pkg.articleMarkdown.trim(),hasFigures:pkg.visuals.length>0,hasPdf:!!pkg.pdfPath,hasPageMap:pkg.sourceKind==="mineru"&&pkg.viewerIndex.pages.length>0,hasLayoutBoxes:pkg.sourceKind==="mineru"&&pkg.viewerIndex.pages.some(p=>p.blocks.some(b=>!!b.bbox_norm))},...(structured?{structured}:{})};return pkg;
}
