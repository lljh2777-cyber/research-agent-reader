import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { LLMProvider } from "../providers/adapters";
import type { ChatMessage } from "../config";
import type { ReadingBackend, ReadingBackendRequest } from "./types";

export class DirectReadingBackend implements ReadingBackend {
	readonly images: boolean;
	constructor(private provider: LLMProvider, readonly name: string, readonly model: string, private streaming: boolean) { this.images = provider.capabilities.vision; }
	async complete(request: ReadingBackendRequest): Promise<string> {
		request.signal.throwIfAborted();
		if (request.images.length && !this.images) throw new Error("当前模型未启用图像能力");
		const messages: ChatMessage[] = [{ role: "system", content: request.system }, { role: "user", content: request.images.length
			? [...request.images.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } })), { type: "text" as const, text: request.prompt }]
			: request.prompt }];
		let cancel: (() => void) | undefined;
		const abort = (): void => cancel?.(); request.signal.addEventListener("abort", abort, { once: true });
		try {
			const options = { registerCancel: (callback: () => void) => { cancel = callback; if (request.signal.aborted) callback(); } };
			const payload = { model: this.model, messages, maxTokens: 6000 };
			const result = this.streaming ? await this.provider.stream(payload, (delta) => request.onDelta?.(delta), options) : await this.provider.complete(payload, options);
			request.signal.throwIfAborted();
			if (!result.text?.trim()) throw new Error("模型返回空结果"); return result.text;
		} finally { request.signal.removeEventListener("abort", abort); }
	}
}
export function readingCodexArgs(directory: string, model: string, images: string[]): string[] {
	return ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never",
		"--disable", "shell_tool", "--disable", "apps", "--disable", "browser_use", "--disable", "browser_use_external",
		"-c", 'web_search="disabled"', "-C", directory, ...(model ? ["--model", model] : []),
		...images.flatMap((filename) => ["--image", filename]), "-"];
}
export class CodexReadingBackend implements ReadingBackend {
	readonly images = true;
	readonly name = "Codex CLI";
	constructor(private executable: string, readonly model: string, private pluginDirectory: string) {}
	async complete(request: ReadingBackendRequest): Promise<string> {
		request.signal.throwIfAborted();
		const directory = path.join(this.pluginDirectory, "reading-runs", randomUUID());
		await fs.mkdir(directory, { recursive: true });
		const imagePaths: string[] = [];
		for (const [index, image] of request.images.entries()) {
			const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/s.exec(image.dataUrl);
			if (!match) throw new Error("不支持的阅读图像格式");
			const filename = path.join(directory, "evidence-" + index + "." + (match[1] === "jpeg" ? "jpg" : match[1]));
			await fs.writeFile(filename, Buffer.from(match[2], "base64"), { flag: "wx", mode: 0o600 }); imagePaths.push(filename);
		}
		request.signal.throwIfAborted();
		let executable = this.executable; let args = readingCodexArgs(directory, this.model, imagePaths);
		if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
			const shim = executable.replace(/\.(cmd|bat)$/i, ".ps1"); await fs.access(shim);
			executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
			args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", shim, ...args];
		}
		return new Promise((resolve, reject) => {
			let pending = ""; let errorText = ""; let answer = ""; let total = 0; let settled = false;
			const child = spawn(executable, args, { cwd: directory, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
			const finish = (error?: Error): void => {
				if (settled) return; settled = true; request.signal.removeEventListener("abort", abort); clearTimeout(timer);
				if (error) { child.kill(); reject(error); } else resolve(answer);
			};
			const abort = (): void => finish(new Error("已停止阅读生成"));
			const timer = setTimeout(() => finish(new Error("Codex 阅读请求超过 5 分钟")), 300_000);
			const consume = (line: string): void => {
				try {
					const event = JSON.parse(line);
					if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") answer = event.item.text;
					if (event.type === "error" || event.type === "turn.failed") errorText += "\n" + (event.message || event.error?.message || "Codex 请求失败");
				} catch { /* Non-JSON CLI diagnostics are not assistant messages. */ }
			};
			child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
			child.stdout.on("data", (text: string) => { total += text.length; if (total > 4_000_000) return finish(new Error("Codex 输出超过阅读上限"));
				pending += text; const lines = pending.split(/\r?\n/); pending = lines.pop() || ""; lines.forEach(consume); });
			child.stderr.on("data", (text: string) => { errorText = (errorText + text).slice(-8000); });
			child.on("error", (error) => finish(error)); child.stdin.on("error", (error) => finish(error));
			child.on("close", (code) => { if (pending) consume(pending); if (code !== 0 || !answer.trim()) finish(new Error(errorText || "Codex 未返回有效阅读回答")); else finish(); });
			request.signal.addEventListener("abort", abort, { once: true });
			if (request.signal.aborted) abort(); else child.stdin.end(request.system + "\n\n" + request.prompt);
		});
	}
}
