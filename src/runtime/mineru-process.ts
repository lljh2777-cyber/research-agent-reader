import { spawn } from "node:child_process";
import * as path from "node:path";

import { windowsJobWrappedCommand } from "./windows-job-runner";

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

export class MineruTerminationUnconfirmedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MineruTerminationUnconfirmedError";
	}
}

interface MineruProcessControlDeps {
	spawnProcess?: typeof spawn;
	platform?: NodeJS.Platform;
	windowsRoot?: string;
	helperTimeoutMs?: number;
	finalCloseTimeoutMs?: number;
	checkWindowsDescendants?: (rootPid: number) => Promise<boolean>;
}

/**
 * Run MinerU without a shell. Abort/timeout resolve only after the spawned
 * process tree has been observed closed; staging cleanup may safely begin
 * after this promise settles.
 */
export function runMineruProcessCommand(
	request: MineruProcessRequest,
	mineruToken = "",
	control: MineruProcessControlDeps = {},
): Promise<MineruProcessResult> {
	if (request.signal.aborted) {
		return Promise.resolve({
			exitCode: 130,
			stdout: "",
			stderr: "已在启动前取消；未创建 MinerU 进程",
		});
	}
	return new Promise((resolve, reject) => {
		const MAX_HELPER_OUTPUT_CHARS = 1_000_000;
		const platform = control.platform || process.platform;
		const spawnProcess = control.spawnProcess || spawn;
		const helperTimeoutMs = Math.max(100, control.helperTimeoutMs || 7_500);
		const finalCloseTimeoutMs = Math.max(100, control.finalCloseTimeoutMs || 12_000);
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
		const requestedArgs = [...request.baseArgs, ...request.cliArgs];
		const usesWindowsJob = platform === "win32" && !control.spawnProcess;
		const launch = usesWindowsJob
			? windowsJobWrappedCommand(control.windowsRoot || process.env.SystemRoot || "C:\\Windows", request.command, requestedArgs, request.cwd)
			: { command: request.command, args: requestedArgs };
		const child = spawnProcess(launch.command, launch.args, {
			cwd: request.cwd,
			shell: false,
			windowsHide: true,
			detached: platform !== "win32",
			env: mineruEnv,
		});
		let timer: ReturnType<typeof setTimeout> | null = null;
		const settle = (result: MineruProcessResult | Error): void => {
			if (settled) return;
			settled = true;
			request.signal.removeEventListener("abort", onAbort);
			if (timer) clearTimeout(timer);
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
		const waitForProcessGroupExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				try {
					process.kill(-pid, 0);
				} catch (error) {
					const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
					if (code === "ESRCH") return true;
				}
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
			}
			return false;
		};
		const runTaskkill = async (): Promise<{ exitCode: number; error: Error | null }> => {
			if (!child.pid) return { exitCode: 1, error: new Error("MinerU 子进程没有 PID") };
			return await new Promise((resolveTaskkill) => {
				let completed = false;
				const windowsPath = platform === "win32" ? path.win32 : path.posix;
				const windowsRoot = windowsPath.resolve(control.windowsRoot || process.env.SystemRoot || "C:\\Windows");
				const helperPath = windowsPath.join(windowsRoot, "System32", "taskkill.exe");
				const helper = spawnProcess(helperPath, ["/pid", String(child.pid), "/T", "/F"], {
					shell: false,
					windowsHide: true,
				});
				const helperTimer = setTimeout(() => {
					try { helper.kill("SIGKILL"); } catch { /* Report the timeout below. */ }
					finish({ exitCode: 1, error: new Error("taskkill helper 超时") });
				}, helperTimeoutMs);
				const finish = (result: { exitCode: number; error: Error | null }): void => {
					if (completed) return;
					completed = true;
					clearTimeout(helperTimer);
					resolveTaskkill(result);
				};
				helper.once("error", (error: Error) => finish({ exitCode: 1, error }));
				helper.once("close", (code: number | null) => finish({ exitCode: code ?? 1, error: null }));
			});
		};
		const noWindowsDescendants = async (rootPid: number): Promise<boolean> => {
			if (control.checkWindowsDescendants) return await control.checkWindowsDescendants(rootPid);
			const windowsPath = platform === "win32" ? path.win32 : path.posix;
			const windowsRoot = windowsPath.resolve(control.windowsRoot || process.env.SystemRoot || "C:\\Windows");
			const helperPath = windowsPath.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			const script = [
				"$ErrorActionPreference='Stop'",
				`$root=[uint32]${rootPid}`,
				"$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)",
				"$front=@($root)",
				"$seen=@{}",
				"while($front.Count -gt 0){",
				"  $next=@()",
				"  foreach($p in $all){ if($front -contains [uint32]$p.ParentProcessId){ $id=[uint32]$p.ProcessId; if(-not $seen.ContainsKey($id)){ $seen[$id]=$true; $next += $id } } }",
				"  $front=$next",
				"}",
				"if($seen.Count -gt 0){ exit 3 }",
				"exit 0",
			].join("; ");
			return await new Promise<boolean>((resolveCheck) => {
				let completed = false;
				const helper = spawnProcess(helperPath, [
					"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
				], { shell: false, windowsHide: true });
				const finish = (safe: boolean): void => {
					if (completed) return;
					completed = true;
					clearTimeout(helperTimer);
					resolveCheck(safe);
				};
				const helperTimer = setTimeout(() => {
					try { helper.kill("SIGKILL"); } catch { /* Fail closed below. */ }
					finish(false);
				}, helperTimeoutMs);
				helper.once("error", () => finish(false));
				helper.once("close", (code: number | null) => finish(code === 0));
			});
		};
		const confirmTreeGone = async (): Promise<boolean> => {
			if (!child.pid) return false;
			if (usesWindowsJob) return closeObserved;
			if (platform === "win32") return await noWindowsDescendants(child.pid);
			return await waitForProcessGroupExit(child.pid, finalCloseTimeoutMs);
		};
		let terminationPromise: Promise<void> | null = null;
		const terminateTree = (exitCode: 124 | 130, message: string): Promise<void> => {
			if (terminationPromise) return terminationPromise;
			terminating = true;
			terminationPromise = (async () => {
				if (timer) clearTimeout(timer);
				let terminationCommandSucceeded = false;
				if (!closeObserved) {
					if (platform === "win32") {
						const taskkill = await runTaskkill();
						if (!taskkill.error && taskkill.exitCode === 0) {
							terminationCommandSucceeded = true;
						} else {
							stderr = `${stderr}\nMinerU 进程树终止未确认：${taskkill.error?.message || `taskkill 退出码 ${taskkill.exitCode}`}`.trim();
							try { child.kill(); } catch { /* Continue to close confirmation. */ }
						}
						if (!await waitForClose(10_000)) {
							try { child.kill("SIGKILL"); } catch { /* Continue to final wait. */ }
						}
					} else if (child.pid) {
						try {
							process.kill(-child.pid, "SIGTERM");
						} catch {
							try { child.kill("SIGTERM"); } catch { /* Continue to escalation. */ }
						}
						terminationCommandSucceeded = await waitForProcessGroupExit(child.pid, 3_000);
						if (!terminationCommandSucceeded) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								try { child.kill("SIGKILL"); } catch { /* Continue to final wait. */ }
							}
							terminationCommandSucceeded = await waitForProcessGroupExit(child.pid, finalCloseTimeoutMs);
						}
					} else {
						try { child.kill("SIGKILL"); } catch { /* Continue to final wait. */ }
					}
				}
				// Never release the caller into staging cleanup while the command may
				// still have an open handle to the authorized snapshot or output tree.
				// After escalation, wait for the actual child close event instead of
				// converting an unconfirmed kill attempt into a successful stop.
				if (!closeObserved && !await waitForClose(finalCloseTimeoutMs)) {
					throw new MineruTerminationUnconfirmedError(
						`${message}，但 MinerU 子进程在终止期限内没有关闭；进程树终止未确认`,
					);
				}
				const treeTerminationConfirmed = (closeObserved || terminationCommandSucceeded)
					&& await confirmTreeGone();
				if (!treeTerminationConfirmed) {
					throw new MineruTerminationUnconfirmedError(
						`${message}，直接子进程已关闭，但无法确认其完整进程树退出`,
					);
				}
				settle({
					exitCode,
					stdout,
					stderr: `${stderr}\n${message}；已确认 MinerU 进程树退出`.trim(),
				});
			})().catch((error) => settle(error instanceof Error ? error : new Error(String(error))));
			return terminationPromise;
		};
		const onAbort = (): void => { void terminateTree(130, "已手动停止"); };
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
			if (!terminating) {
				terminating = true;
				void confirmTreeGone().then((confirmed) => {
					if (!confirmed) {
						settle(new MineruTerminationUnconfirmedError(
							"MinerU 直接子进程已关闭，但无法确认其完整进程树退出",
						));
						return;
					}
					settle({ exitCode: code ?? 1, stdout, stderr });
				}, (error) => settle(error instanceof Error ? error : new Error(String(error))));
			}
		});
		request.signal.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => { void terminateTree(124, "MinerU 提取超时"); }, request.timeoutMs);
		// The signal can be aborted between the pre-spawn check and listener
		// installation. Re-check only after every lifecycle listener exists.
		if (request.signal.aborted) onAbort();
	});
}
