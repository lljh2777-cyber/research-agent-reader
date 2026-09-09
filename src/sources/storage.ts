import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SourceStorage {
	read(relative: string, limit?: number): Promise<Uint8Array | null>;
	list(relative: string): Promise<Array<{name:string;directory:boolean}>>;
	mkdir(relative: string, exclusive?: boolean): Promise<void>;
	create(relative: string, bytes: Uint8Array): Promise<void>;
}

/** Fixed-root, bounded, create-only IO. Reads never mkdir; no deletion or replacement API. */
export class FileSourceStorage implements SourceStorage {
	constructor(readonly root: string) { if (!path.isAbsolute(root)) throw new Error("原文存储需要绝对根路径"); }
	private segments(relative:string):string[] {
		if (!relative || relative.length>600 || relative.includes("\\") || relative.startsWith("/") || relative.split("/").some(p=>!p || p==="." || p===".." || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p))) throw new Error("原文路径无效");
		return relative.split("/");
	}
	private async resolve(relative:string):Promise<{file:string;nodes:string}> {
		const root=path.resolve(this.root), initial=await fs.lstat(root);if(!initial.isDirectory() || initial.isSymbolicLink())throw new Error("原文根目录必须是普通目录");
		const nodes=[`${initial.dev}:${initial.ino}`];let cursor=root;
		for(const part of this.segments(relative)){cursor=path.join(cursor,part);const stat=await fs.lstat(cursor);if(stat.isSymbolicLink() || (!stat.isDirectory()&&!stat.isFile()))throw new Error("原文路径包含链接或特殊文件");nodes.push(`${stat.dev}:${stat.ino}`);}
		if(await fs.realpath(cursor)!==path.join(await fs.realpath(root),...this.segments(relative)))throw new Error("原文路径解析变化");
		return {file:cursor,nodes:nodes.join("/")};
	}
	async read(relative:string,limit=256*1024):Promise<Uint8Array|null> {
		let resolved;try{resolved=await this.resolve(relative);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
		const handle=await fs.open(resolved.file,"r");
		try{const stat=await handle.stat();if(!stat.isFile() || stat.size>limit)throw new Error("原文文件类型或大小无效");
			const node=await fs.lstat(resolved.file);if(node.isSymbolicLink() || stat.dev!==node.dev || stat.ino!==node.ino)throw new Error("原文文件在打开时变化");
			const buffer=Buffer.alloc(Math.min(limit,stat.size)+1);let read=0;
			while(read<buffer.length){const result=await handle.read(buffer,read,buffer.length-read,read);if(!result.bytesRead)break;read+=result.bytesRead;}
			const after=await handle.stat();if(read!==stat.size || read>limit || after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || after.ctimeMs!==stat.ctimeMs || (await this.resolve(relative)).nodes!==resolved.nodes)throw new Error("原文文件读取期间变化");return buffer.subarray(0,read);
		}finally{await handle.close();}
	}
	async list(relative:string):Promise<Array<{name:string;directory:boolean}>> {
		let resolved;try{resolved=await this.resolve(relative);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
		const directory=await fs.opendir(resolved.file),entries:Array<{name:string;directory:boolean}>=[];
		try{for(;;){const item=await directory.read();if(!item)break;if(entries.length>=4096)throw new Error("原文目录超过 4096 项，请先整理");if(item.isSymbolicLink() || (!item.isFile()&&!item.isDirectory()))throw new Error("原文目录包含链接或特殊文件");entries.push({name:item.name,directory:item.isDirectory()});}}finally{await directory.close();}
		if((await this.resolve(relative)).nodes!==resolved.nodes)throw new Error("原文目录读取期间变化");return entries;
	}
	async mkdir(relative:string,exclusive=false):Promise<void> {
		const parts=this.segments(relative), parent=parts.slice(0,-1).join("/");
		const rootStat=await fs.lstat(this.root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error("原文根目录无效");
		const before=parent?await this.resolve(parent):{file:path.resolve(this.root),nodes:`${rootStat.dev}:${rootStat.ino}`};
		try{await fs.mkdir(path.join(before.file,parts[parts.length-1]));}catch(error){if(exclusive || (error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
		const resolved=await this.resolve(relative);if(!(await fs.lstat(resolved.file)).isDirectory() || (parent && (await this.resolve(parent)).nodes!==before.nodes))throw new Error("原文目录创建期间变化");
	}
	async create(relative:string,bytes:Uint8Array):Promise<void> {
		const parts=this.segments(relative),parent=parts.slice(0,-1).join("/");if(!parent)throw new Error("原文文件必须位于专属子目录");
		const before=await this.resolve(parent),target=path.join(before.file,parts[parts.length-1]),handle=await fs.open(target,"wx",0o600);
		try{let written=0;while(written<bytes.length){const result=await handle.write(bytes.subarray(written));if(!result.bytesWritten)throw new Error("原文文件写入未前进");written+=result.bytesWritten;}await handle.sync();if((await this.resolve(parent)).nodes!==before.nodes)throw new Error("原文父目录在写入期间变化");}finally{await handle.close();}
	}
}
