import { spawn } from "node:child_process";

export interface MineruProcessRequest {
	command: string;
	baseArgs: string[];
	cliArgs: string[];
	cwd: string;
	timeoutMs: number;
	signal: AbortSignal;
}

export interface MineruProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Run MinerU without a shell. Abort/timeout resolve only after the spawned
 * process tree has been observed closed; staging cleanup may safely begin
 * after this promise settles.
 */
export function runMineruProcessCommand(
	request: MineruProcessRequest,
	mineruToken = "",
): Promise<MineruProcessResult> {
	return new Promise((resolve, reject) => {
		const MAX_HELPER_OUTPUT_CHARS = 1_000_000;
		let stdout = "";
		let stderr = "";
		let settled = false;
		let terminating = false;
		let closeObserved = false;
		let spawnObserved = false;
		let closeResolver: (() => void) | null = null;
		const closePromise = new Promise<void>((resolveClose) => { closeResolver = resolveClose; });
		const mineruEnv: NodeJS.ProcessEnv = {
			...process.env,
			PYTHONUTF8: "1",
			PYTHONIOENCODING: "utf-8",
		};
		if (mineruToken) mineruEnv.MINERU_TOKEN = mineruToken;
		const child = spawn(request.command, [...request.baseArgs, ...request.cliArgs], {
			cwd: request.cwd,
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
			env: mineruEnv,
		});
		const settle = (result: MineruProcessResult | Error): void => {
			if (settled) return;
			settled = true;
			request.signal.removeEventListener("abort", onAbort);
			clearTimeout(timer);
			if (result instanceof Error) reject(result);
			else resolve(result);
		};
		const waitForClose = async (timeoutMs: number): Promise<boolean> => {
			if (closeObserved) return true;
			let timerId: ReturnType<typeof setTimeout> | null = null;
			const timedOut = new Promise<boolean>((resolveTimeout) => {
				timerId = setTimeout(() => resolveTimeout(false), timeoutMs);
			});
			const result = await Promise.race([closePromise.then(() => true), timedOut]);
			if (timerId !== null) clearTimeout(timerId);
			return result;
		};
		const runTaskkill = async (): Promise<{ exitCode: number; error: Error | null }> => {
			if (!child.pid) return { exitCode: 1, error: new Error("MinerU 子进程没有 PID") };
			return await new Promise((resolveTaskkill) => {
				let completed = false;
				const helper = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
					shell: false,
					windowsHide: true,
				});
				const finish = (result: { exitCode: number; error: Error | null }): void => {
					if (completed) return;
					completed = true;
					resolveTaskkill(result);
				};
				helper.once("error", (error: Error) => finish({ exitCode: 1, error }));
				helper.once("close", (code: number | null) => finish({ exitCode: code ?? 1, error: null }));
			});
		};
		let terminationPromise: Promise<void> | null = null;
		const terminateTree = (exitCode: 124 | 130, message: string): Promise<void> => {
			if (terminationPromise) return terminationPromise;
			terminating = true;
			terminationPromise = (async () => {
				clearTimeout(timer);
				if (!closeObserved) {
					if (process.platform === "win32") {
						const taskkill = await runTaskkill();
						if (taskkill.error || taskkill.exitCode !== 0) {
							try { child.kill(); } catch { /* Continue to close confirmation. */ }
						}
						if (!await waitForClose(10_000)) {
							try { child.kill("SIGKILL"); } catch { /* Continue to final wait. */ }
						}
					} else if (child.pid) {
						try { process.kill(-child.pid, "SIGTERM"); } catch {
							try { child.kill("SIGTERM"); } catch { /* Continue to escalation. */ }
						}
						if (!await waitForClose(3_000)) {
							try { process.kill(-child.pid, "SIGKILL"); } catch {
								try { child.kill("SIGKILL"); } catch { /* Continue to final wait. */ }
							}
						}
					} else {
						try { child.kill("SIGKILL"); } catch { /* Continue to final wait. */ }
					}
				}
				// Never release the caller into staging cleanup while the command may
				// still have an open handle to the authorized snapshot or output tree.
				// After escalation, wait for the actual child close event instead of
				// converting an unconfirmed kill attempt into a successful stop.
				if (!closeObserved) await closePromise;
				settle({
					exitCode,
					stdout,
					stderr: `${stderr}\n${message}；已确认 MinerU 进程树退出`.trim(),
				});
			})().catch((error) => settle(error instanceof Error ? error : new Error(String(error))));
			return terminationPromise;
		};
		const onAbort = (): void => { void terminateTree(130, "已手动停止"); };
		const timer = setTimeout(() => { void terminateTree(124, "MinerU 提取超时"); }, request.timeoutMs);
		if (request.signal.aborted) {
			onAbort();
			return;
		}
		request.signal.addEventListener("abort", onAbort);
		child.once("spawn", () => { spawnObserved = true; });
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_HELPER_OUTPUT_CHARS) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_HELPER_OUTPUT_CHARS) stderr += chunk.toString("utf8");
		});
		child.once("error", (error: Error) => {
			if (!spawnObserved || !child.pid) {
				// A spawn failure means no MinerU process exists and therefore no
				// later staging writer can survive this rejection.
				closeObserved = true;
				closeResolver?.();
				settle(error);
				return;
			}
			stderr = `${stderr}\nMinerU 进程错误：${error.message}`.trim();
			// Errors emitted after spawn (including a failed kill request) are not
			// process-close evidence. Escalate and keep waiting for `close`.
			if (!terminating) void terminateTree(124, "MinerU 进程异常");
		});
		child.once("close", (code: number | null) => {
			closeObserved = true;
			closeResolver?.();
			if (!terminating) settle({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}
