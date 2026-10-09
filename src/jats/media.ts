import { bytesDigest } from "../papers/identity";
import type { JatsAsset } from "./projection";
/** Header checks precede browser decoding. Unsupported originals are never embedded. */
export function imageInfo(bytes:Uint8Array,ref:string):{mime:string;extension:string;width:number;height:number}|undefined {
	const b=Buffer.from(bytes);let width=0,height=0,mime="",extension="";
	if(/\.png$/i.test(ref)&&b.length>=33&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&b.toString("ascii",12,16)==="IHDR"){width=b.readUInt32BE(16);height=b.readUInt32BE(20);mime="image/png";extension="png";}
	else if(/\.jpe?g$/i.test(ref)&&b.length>4&&b[0]===255&&b[1]===216){let at=2;for(let count=0;at+4<b.length&&count<10000;count++){
		if(b[at++]!==255)break;while(b[at]===255)at++;const marker=b[at++];if(marker===217||marker===218)break;if(marker===1||(marker>=208&&marker<=215))continue;const size=b.readUInt16BE(at);if(size<2||at+size>b.length)break;
		if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&size>=8){height=b.readUInt16BE(at+3);width=b.readUInt16BE(at+5);mime="image/jpeg";extension="jpg";break;}at+=size;
	}}
	else if(/\.webp$/i.test(ref)&&b.length>=30&&b.toString("ascii",0,4)==="RIFF"&&b.toString("ascii",8,12)==="WEBP"){
		const type=b.toString("ascii",12,16);if(type==="VP8X"){if(b[20]&2)return undefined;width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
		else if(type==="VP8 "&&b[23]===0x9d&&b[24]===1&&b[25]===0x2a){width=b.readUInt16LE(26)&0x3fff;height=b.readUInt16LE(28)&0x3fff;}
		else if(type==="VP8L"&&b[20]===0x2f){const bits=b.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}mime="image/webp";extension="webp";
	}
	if(!width||!height||width>16000||height>16000||width*height>40000000)return undefined;return {mime,extension,width,height};
}
export function assetFor(ref:string,bytes:Uint8Array):JatsAsset {const info=imageInfo(bytes,ref);return info?{ref,path:`images/${bytesDigest(bytes)}.${info.extension}`}:{ref,issue:"图片格式尚未适配、内容无效或像素超限，原始资源已保留："+ref};}
