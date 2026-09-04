import * as path from "node:path";

const JOB_RUNNER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ResearchReaderJobRunner {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint INFINITE = 0xFFFFFFFF;
  const int JobObjectBasicAccountingInformation = 1;
  const int JobObjectExtendedLimitInformation = 9;

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
    public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public uint dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returnedLength);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
    IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
    out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  static string Quote(string value) {
    if (value.Length == 0) return "\"\"";
    if (value.IndexOfAny(new [] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(c);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  static void Win32(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }

  public static int Run(string file, string[] args, string cwd) {
    IntPtr job = IntPtr.Zero; PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    try {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int limitSize = Marshal.SizeOf(limits); IntPtr limitPtr = Marshal.AllocHGlobal(limitSize);
      try { Marshal.StructureToPtr(limits, limitPtr, false); Win32(SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitPtr, (uint)limitSize), "SetInformationJobObject"); }
      finally { Marshal.FreeHGlobal(limitPtr); }

      var command = new StringBuilder(Quote(file));
      foreach (string arg in args) command.Append(' ').Append(Quote(arg));
      var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.dwFlags = STARTF_USESTDHANDLES;
      si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
      SetHandleInformation(si.hStdInput, 1, 1); SetHandleInformation(si.hStdOutput, 1, 1); SetHandleInformation(si.hStdError, 1, 1);
      Win32(CreateProcess(file, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW,
        IntPtr.Zero, cwd, ref si, out pi), "CreateProcess");
      if (!AssignProcessToJobObject(job, pi.hProcess)) { TerminateProcess(pi.hProcess, 70); throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject"); }
      if (ResumeThread(pi.hThread) == 0xFFFFFFFF) { TerminateProcess(pi.hProcess, 71); throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread"); }
      WaitForSingleObject(pi.hProcess, INFINITE); uint exitCode; Win32(GetExitCodeProcess(pi.hProcess, out exitCode), "GetExitCodeProcess");
      int accountingSize = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)); IntPtr accounting = Marshal.AllocHGlobal(accountingSize);
      try {
        while (true) {
          Win32(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, accounting, (uint)accountingSize, IntPtr.Zero), "QueryInformationJobObject");
          var state = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(accounting, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
          if (state.ActiveProcesses == 0) break;
          Thread.Sleep(50);
        }
      } finally { Marshal.FreeHGlobal(accounting); }
      return unchecked((int)exitCode);
    } finally {
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
      if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}`;

export function windowsJobWrappedCommand(
	windowsRoot: string,
	command: string,
	args: readonly string[],
	cwd: string,
): { command: string; args: string[] } {
	const powershell = path.join(path.resolve(windowsRoot), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const payload = Buffer.from(JSON.stringify({ command, args: [...args], cwd }), "utf8").toString("base64");
	const script = `$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'\n${JOB_RUNNER_SOURCE}\n'@;`
		+ `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;`
		+ `$code=[ResearchReaderJobRunner]::Run([string]$p.command,[string[]]$p.args,[string]$p.cwd);exit $code`;
	return {
		command: powershell,
		args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
	};
}
