import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface VaultFilesystemAdapter {
	getBasePath?: () => string;
	getFullPath?: (vaultPath: string) => string;
}

export interface TrustedVaultPath {
	vaultRoot: string;
	realVaultRoot: string;
	absolutePath: string;
	realPath: string;
	components: Array<{ absolutePath: string; realPath: string; dev: bigint; ino: bigint }>;
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function segmentsOf(vaultRelativePath: string): string[] {
	const normalized = String(vaultRelativePath || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const segments = normalized.split("/");
	if (!normalized || segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error(`Vault 相对路径不合法：${vaultRelativePath}`);
	}
	return segments;
}

export function resolveVaultFilesystemRoot(
	adapter: VaultFilesystemAdapter,
	explicitVaultRoot = "",
): string {
	const root = String(explicitVaultRoot
		|| adapter.getBasePath?.()
		|| adapter.getFullPath?.("")
		|| "").trim();
	if (!root || !path.isAbsolute(root)) {
		throw new Error("当前 Vault 不提供可信的桌面文件系统根路径");
	}
	return path.resolve(root);
}

/** Walk every existing component from the real Vault root without following links. */
export async function resolveTrustedVaultPath(
	adapter: VaultFilesystemAdapter,
	vaultRelativePath: string,
	options: {
		explicitVaultRoot?: string;
		expectedType?: "file" | "directory";
	} = {},
): Promise<TrustedVaultPath> {
	const vaultRoot = resolveVaultFilesystemRoot(adapter, options.explicitVaultRoot);
	const rootStats = await fs.promises.lstat(vaultRoot);
	if (!rootStats.isDirectory() && !rootStats.isSymbolicLink()) {
		throw new Error("当前 Vault 根路径不是目录");
	}
	const realVaultRoot = await fs.promises.realpath(vaultRoot);
	let cursor = realVaultRoot;
	const components: TrustedVaultPath["components"] = [];
	const segments = segmentsOf(vaultRelativePath);
	for (const [index, segment] of segments.entries()) {
		cursor = path.join(cursor, segment);
		const stats = await fs.promises.lstat(cursor, { bigint: true });
		const last = index === segments.length - 1;
		if (stats.isSymbolicLink()) {
			throw new Error(`Vault 路径包含符号链接或 junction：${vaultRelativePath}`);
		}
		if (!last && !stats.isDirectory()) throw new Error(`Vault 路径祖先不是目录：${vaultRelativePath}`);
		if (last && options.expectedType === "file" && !stats.isFile()) {
			throw new Error(`Vault 目标不是普通文件：${vaultRelativePath}`);
		}
		if (last && options.expectedType === "directory" && !stats.isDirectory()) {
			throw new Error(`Vault 目标不是普通目录：${vaultRelativePath}`);
		}
		const realCursor = await fs.promises.realpath(cursor);
		if (!isInside(realVaultRoot, realCursor)) {
			throw new Error(`Vault 路径解析到根目录之外：${vaultRelativePath}`);
		}
		components.push({ absolutePath: cursor, realPath: realCursor, dev: stats.dev, ino: stats.ino });
	}
	const realPath = await fs.promises.realpath(cursor);
	return { vaultRoot, realVaultRoot, absolutePath: cursor, realPath, components };
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size
		&& left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameResolvedNodes(left: TrustedVaultPath, right: TrustedVaultPath): boolean {
	return left.realVaultRoot === right.realVaultRoot
		&& left.realPath === right.realPath
		&& left.components.length === right.components.length
		&& left.components.every((item, index) => {
			const other = right.components[index];
			return Boolean(other) && item.absolutePath === other.absolutePath
				&& item.realPath === other.realPath && item.dev === other.dev && item.ino === other.ino;
		});
}

/** Read one ordinary Vault file through the same handle that is fstat-verified. */
export async function readTrustedVaultFile(
	adapter: VaultFilesystemAdapter,
	vaultRelativePath: string,
	maxBytes: number,
	explicitVaultRoot = "",
): Promise<Buffer> {
	const resolved = await resolveTrustedVaultPath(adapter, vaultRelativePath, {
		explicitVaultRoot,
		expectedType: "file",
	});
	const finalComponent = resolved.components[resolved.components.length - 1];
	const before = await fs.promises.lstat(resolved.absolutePath, { bigint: true });
	if (!before.isFile() || before.size > BigInt(maxBytes)) {
		throw new Error(`Vault 文件超过安全上限或不是普通文件：${vaultRelativePath}`);
	}
	const noFollow = Number((fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW || 0);
	if (!finalComponent || finalComponent.dev !== before.dev || finalComponent.ino !== before.ino) {
		throw new Error(`Vault 文件在可信路径解析后发生变化：${vaultRelativePath}`);
	}
	const handle = await fs.promises.open(resolved.absolutePath, fs.constants.O_RDONLY | noFollow);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || !sameFile(before, opened)) {
			throw new Error(`Vault 文件在打开期间发生变化：${vaultRelativePath}`);
		}
		const reopenedPath = await resolveTrustedVaultPath(adapter, vaultRelativePath, {
			explicitVaultRoot,
			expectedType: "file",
		});
		if (!sameResolvedNodes(resolved, reopenedPath)) {
			throw new Error(`Vault 文件祖先在打开期间发生变化：${vaultRelativePath}`);
		}
		const bytes = await handle.readFile();
		if (bytes.byteLength > maxBytes || BigInt(bytes.byteLength) !== opened.size) {
			throw new Error(`Vault 文件实际读取长度不一致或超过安全上限：${vaultRelativePath}`);
		}
		const after = await handle.stat({ bigint: true });
		if (!sameFile(opened, after)) throw new Error(`Vault 文件在读取期间发生变化：${vaultRelativePath}`);
		const finalPath = await resolveTrustedVaultPath(adapter, vaultRelativePath, {
			explicitVaultRoot,
			expectedType: "file",
		});
		if (!sameResolvedNodes(resolved, finalPath)) {
			throw new Error(`Vault 文件祖先在读取期间发生变化：${vaultRelativePath}`);
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function createRelativeToVerifiedDirectory(
	parent: TrustedVaultPath,
	fileName: string,
	content: string,
): Promise<void> {
	if (!fileName || path.basename(fileName) !== fileName || /[\\/]/.test(fileName)) {
		throw new Error("Vault 文件名不合法");
	}
	const parentNode = parent.components[parent.components.length - 1];
	if (!parentNode) throw new Error("Vault 可信父目录身份缺失");
	const helper = [
		"const fs=require('node:fs')",
		"const expectedDev=BigInt(process.argv[1])",
		"const expectedIno=BigInt(process.argv[2])",
		"const name=process.argv[3]",
		"const expectedPath=process.argv[4]",
		"const root=process.argv[5]",
		"if(!name||require('node:path').basename(name)!==name||/[\\\\/]/.test(name))process.exit(71)",
		"const dir=fs.statSync('.', {bigint:true})",
		"const path=require('node:path')",
		"const inside=(candidate)=>{const rel=path.relative(root,candidate);return rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel))}",
		"const location=fs.realpathSync('.')",
		"if(!dir.isDirectory()||dir.dev!==expectedDev||dir.ino!==expectedIno||location!==expectedPath||!inside(location))process.exit(72)",
		"const noFollow=Number(fs.constants.O_NOFOLLOW||0)",
		"const temp='.research-reader-'+require('node:crypto').randomUUID()+'.tmp'",
		"const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|noFollow,0o600)",
		"let total=0",
		"process.stdin.on('data',(chunk)=>{total+=chunk.length;fs.writeSync(fd,chunk)})",
		"process.stdin.on('end',()=>{try{fs.fsyncSync(fd);const s=fs.fstatSync(fd,{bigint:true});fs.closeSync(fd);if(!s.isFile()||s.size!==BigInt(total))process.exit(73);let finalDir=fs.statSync('.',{bigint:true});let finalLocation=fs.realpathSync('.');if(finalDir.dev!==expectedDev||finalDir.ino!==expectedIno||finalLocation!==expectedPath||!inside(finalLocation))process.exit(74);fs.linkSync(temp,name);const linked=fs.statSync(name,{bigint:true});finalDir=fs.statSync('.',{bigint:true});finalLocation=fs.realpathSync('.');if(linked.dev!==s.dev||linked.ino!==s.ino||finalDir.dev!==expectedDev||finalDir.ino!==expectedIno||finalLocation!==expectedPath||!inside(finalLocation)){try{fs.unlinkSync(name)}catch{};process.exit(75)}fs.unlinkSync(temp);process.exit(0)}catch(error){try{fs.closeSync(fd)}catch{};try{fs.unlinkSync(temp)}catch{};throw error}})",
	].join(";");
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [
			"-e", helper, String(parentNode.dev), String(parentNode.ino), fileName, parent.realPath, parent.realVaultRoot,
		], {
			cwd: parent.realPath,
			shell: false,
			windowsHide: true,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			stdio: ["pipe", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString("utf8");
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`可信 Vault 相对写入失败（退出码 ${code ?? "未知"}）：${stderr.slice(0, 500)}`));
		});
		child.stdin.on("error", (error) => reject(error));
		child.stdin.end(content, "utf8");
	});
}

export async function ensureTrustedVaultDirectory(
	adapter: VaultFilesystemAdapter,
	vaultRelativePath: string,
	explicitVaultRoot = "",
): Promise<TrustedVaultPath> {
	const vaultRoot = resolveVaultFilesystemRoot(adapter, explicitVaultRoot);
	const realVaultRoot = await fs.promises.realpath(vaultRoot);
	let cursor = realVaultRoot;
	for (const segment of segmentsOf(vaultRelativePath)) {
		cursor = path.join(cursor, segment);
		try {
			await fs.promises.mkdir(cursor);
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
			if (code !== "EEXIST") throw error;
		}
		const stats = await fs.promises.lstat(cursor);
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new Error(`Vault 目录包含符号链接、junction 或非目录对象：${vaultRelativePath}`);
		}
		const realCursor = await fs.promises.realpath(cursor);
		if (!isInside(realVaultRoot, realCursor)) throw new Error(`Vault 目录解析到根目录之外：${vaultRelativePath}`);
	}
	return await resolveTrustedVaultPath(adapter, vaultRelativePath, {
		explicitVaultRoot,
		expectedType: "directory",
	});
}

export async function createTrustedVaultTextFile(
	adapter: VaultFilesystemAdapter,
	vaultRelativePath: string,
	content: string,
	explicitVaultRoot = "",
): Promise<void> {
	const segments = segmentsOf(vaultRelativePath);
	const fileName = segments.pop();
	if (!fileName) throw new Error("Vault 文件名为空");
	const parentRelative = segments.join("/");
	const parent = await ensureTrustedVaultDirectory(adapter, parentRelative, explicitVaultRoot);
	const parentBeforeWrite = await resolveTrustedVaultPath(adapter, parentRelative, {
		explicitVaultRoot,
		expectedType: "directory",
	});
	if (!sameResolvedNodes(parent, parentBeforeWrite)) throw new Error("Vault 写入父目录身份发生变化");
	await createRelativeToVerifiedDirectory(parent, fileName, content);
	await resolveTrustedVaultPath(adapter, vaultRelativePath, {
		explicitVaultRoot,
		expectedType: "file",
	});
}
