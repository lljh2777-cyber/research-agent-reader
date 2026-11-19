import * as fs from "node:fs/promises";
import * as path from "node:path";

// Observe package inputs only. Reading file metadata also works on mounts without native watch events.
async function packageStamp(root: string): Promise<string> {
	if (!root) return "";
	const rows: unknown[] = [root];
	try {
		const folders = await fs.readdir(root, { withFileTypes: true });
		for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!folder.isDirectory() || /^[._]/.test(folder.name)) continue;
			const stat = (name: string) => fs.lstat(path.join(root, folder.name, name)).then(
				file => file.isFile() ? [file.size, file.mtimeMs, file.ctimeMs, file.ino] : null,
				(error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : error.code,
			);
			const original = await stat("paper.md");
			if (!original) continue;
			const [translation, manifest] = await Promise.all([stat("paper.zh-CN.md"), stat("translation.json")]);
			rows.push([folder.name, original, translation, manifest]);
		}
	} catch (error) {
		rows.push((error as NodeJS.ErrnoException).code || "unreadable");
	}
	return JSON.stringify(rows);
}

export class ClipperChanges {
	// A busy view can decline delivery and catch up on the next check.
	private readonly listeners = new Map<() => boolean, string | undefined>();
	private timer?: ReturnType<typeof setTimeout>;
	private generation = 0;
	constructor(private readonly root: () => string) {}

	subscribe(listener: () => boolean): () => void {
		this.listeners.set(listener, undefined);
		if (this.listeners.size === 1) void this.check(++this.generation);
		return () => {
			this.listeners.delete(listener);
			if (!this.listeners.size) this.stop();
		};
	}

	stop(): void {
		this.generation++;
		clearTimeout(this.timer);
		this.listeners.clear();
	}

	private async check(generation: number): Promise<void> {
		const stamp = await packageStamp(this.root());
		if (generation !== this.generation) return;
		try {
			for (const [listener, previous] of this.listeners) {
				if (stamp !== previous && listener()) this.listeners.set(listener, stamp);
			}
		} finally {
			if (generation === this.generation) this.timer = setTimeout(() => void this.check(generation), 3000);
		}
	}
}
