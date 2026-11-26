import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export function isPathInside(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureContainedOutputDirectory(rootPath: string, directoryPath: string): Promise<string> {
	const relativeDirectory = path.relative(rootPath, directoryPath);
	if (
		!relativeDirectory
		|| relativeDirectory.startsWith("..")
		|| path.isAbsolute(relativeDirectory)
	) {
		throw new Error("任务输出目录超出插件存储目录");
	}
	let currentPath = rootPath;
	for (const segment of relativeDirectory.split(path.sep)) {
		const nextPath = path.join(currentPath, segment);
		try {
			await fs.mkdir(nextPath);
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error
				? String(error.code)
				: "";
			if (code !== "EEXIST") throw error;
		}
		const directStats = await fs.lstat(nextPath);
		if (directStats.isSymbolicLink()) throw new Error("任务输出目录不能是符号链接或 junction");
		if (!directStats.isDirectory()) throw new Error("任务输出目录不是文件夹");
		const resolvedPath = await fs.realpath(nextPath);
		if (!isPathInside(rootPath, resolvedPath)) {
			throw new Error("任务输出目录超出插件存储目录");
		}
		currentPath = resolvedPath;
	}
	return currentPath;
}

async function assertSafeExistingTarget(
	rootPath: string,
	absolutePath: string,
): Promise<void> {
	try {
		const existingStats = await fs.lstat(absolutePath);
		if (existingStats.isSymbolicLink()) throw new Error("任务输出文件不能是符号链接");
		if (!existingStats.isFile()) throw new Error("任务输出目标不是普通文件");
		const resolvedFile = await fs.realpath(absolutePath);
		if (!isPathInside(rootPath, resolvedFile)) {
			throw new Error("任务输出文件超出插件存储目录");
		}
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
		if (code !== "ENOENT") throw error;
	}
}

export async function writeContainedTextFile(
	rootPath: string,
	targetPath: string,
	getText: () => string,
): Promise<void> {
	const directoryPath = await ensureContainedOutputDirectory(rootPath, path.dirname(targetPath));
	const absolutePath = path.join(directoryPath, path.basename(targetPath));
	if (!isPathInside(rootPath, absolutePath)) {
		throw new Error("任务输出文件超出插件存储目录");
	}
	await assertSafeExistingTarget(rootPath, absolutePath);
	const text = getText();
	const temporaryPath = path.join(
		directoryPath,
		`.${path.basename(absolutePath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
	);
	const handle = await fs.open(temporaryPath, "wx");
	try {
		try {
			await handle.writeFile(text, "utf8");
		} finally {
			await handle.close();
		}
		const temporaryStats = await fs.lstat(temporaryPath);
		const resolvedTemporary = await fs.realpath(temporaryPath);
		if (
			temporaryStats.isSymbolicLink()
			|| !temporaryStats.isFile()
			|| !isPathInside(rootPath, resolvedTemporary)
		) {
			throw new Error("任务输出临时文件未落在可信目录内");
		}
		// Re-check the destination immediately before replacing the complete previous file.
		await assertSafeExistingTarget(rootPath, absolutePath);
		await fs.rename(temporaryPath, absolutePath);
	} catch (error) {
		try {
			await fs.unlink(temporaryPath);
		} catch (cleanupError) {
			// Preserve the original filesystem error and its code when cleanup also fails.
			throw Object.assign(error as Error, { cleanupError });
		}
		throw error;
	}
}
