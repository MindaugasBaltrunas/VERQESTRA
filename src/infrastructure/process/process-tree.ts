// Proceso medžio nužudymas su verifikacija. Elgesio etalonas: AG_loop core/process-tree.ts
// (2026-07-07 audito P1: helper'iai, viršiję biudžetą apkrautoje mašinoje, būdavo nužudomi
// įpusėję, o funkcija grįždavo „sėkmingai" palikusi visą užtimeout'intą medį gyvą).

import { spawn, type ChildProcess } from "node:child_process";

export type KillTreeResult = {
  cancel: () => void;
  done: Promise<void>;
};

export type IgnoredProcessRunner = (command: string, args: string[], timeoutMs?: number) => Promise<boolean>;

export const helperKillTimeoutMs = 1000;
export const helperCloseGraceMs = 250;
export const posixForceKillGraceMs = 1000;
// Verifikuojamo tree-kill bandymų skaičius: kiekvienas bandymas dvigubina helper biudžetą
// (1s, 2s, 4s), nes apkrautoje Windows mašinoje vien PowerShell šaltasis startas viršija 1s.
export const treeKillMaxAttempts = 3;

export function windowsTreeKillWorstCaseMs(): number {
  let total = 0;
  for (let attempt = 0; attempt < treeKillMaxAttempts; attempt += 1) {
    const budgetMs = helperKillTimeoutMs * 2 ** attempt;
    total += 2 * (budgetMs + helperCloseGraceMs);
  }
  return total;
}

export function timeoutFallbackGraceMsForPlatform(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? windowsTreeKillWorstCaseMs() + 1000 : posixForceKillGraceMs + 500;
}

// `process.kill(pid, 0)` nesiunčia signalo — tik patikrina egzistavimą. EPERM reiškia, kad
// procesas yra, bet neprieinamas, tad laikomas gyvu. Tai ir scheduling `processIsAlive`
// porto reali implementacija.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function runIgnoredProcess(
  command: string,
  args: string[],
  timeoutMs = helperKillTimeoutMs,
  closeGraceMs = helperCloseGraceMs,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    let settled = false;
    let timedOut = false;
    let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
      closeGraceTimer = setTimeout(() => finish(false), closeGraceMs);
      closeGraceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeGraceTimer);
      resolve(ok);
    };

    child.on("error", () => finish(false));
    // Biudžetą viršijęs helper'is laikomas nepavykusiu, net jei close grace metu baigė
    // švariai — taip Windows PowerShell → taskkill fallback'as lieka deterministinis.
    child.on("close", (code) => finish(!timedOut && code === 0));
  });
}

export function runWindowsTaskKill(
  rootPid: number,
  runner: IgnoredProcessRunner = runIgnoredProcess,
  timeoutMs: number = helperKillTimeoutMs,
): Promise<boolean> {
  return runner("taskkill", ["/T", "/F", "/PID", String(rootPid)], timeoutMs);
}

export function runWindowsPowerShellTreeKill(
  rootPid: number,
  runner: IgnoredProcessRunner = runIgnoredProcess,
  timeoutMs: number = helperKillTimeoutMs,
): Promise<boolean> {
  const script = `
$root = ${rootPid}
$seen = @{}
$queue = New-Object System.Collections.Queue
$targets = New-Object System.Collections.Generic.List[int]
$queue.Enqueue([int]$root)
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
while ($queue.Count -gt 0) {
  $parent = [int]$queue.Dequeue()
  foreach ($proc in $procs | Where-Object { $_.ParentProcessId -eq $parent }) {
    $id = [int]$proc.ProcessId
    if (-not $seen.ContainsKey($id)) {
      $seen[$id] = $true
      $targets.Add($id)
      $queue.Enqueue($id)
    }
  }
}
foreach ($id in $targets) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $root -Force -ErrorAction SilentlyContinue
`;
  return runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], timeoutMs);
}

// Verifikuojamas tree-kill: po kiekvieno PS→taskkill bandymo tikrinama, ar root PID tikrai
// nebegyvas; jei gyvas — kartojama su padvigubintu helper biudžetu.
export async function runWindowsProcessTreeKill(
  rootPid: number,
  runner: IgnoredProcessRunner = runIgnoredProcess,
  alive: (pid: number) => boolean = isProcessAlive,
): Promise<void> {
  for (let attempt = 0; attempt < treeKillMaxAttempts; attempt += 1) {
    const budgetMs = helperKillTimeoutMs * 2 ** attempt;
    const powershellOk = await runWindowsPowerShellTreeKill(rootPid, runner, budgetMs);
    if (!powershellOk) {
      await runWindowsTaskKill(rootPid, runner, budgetMs);
    }
    if (!alive(rootPid)) {
      return;
    }
  }
}

export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): KillTreeResult {
  if (child.pid === undefined) return { cancel: () => undefined, done: Promise.resolve() };

  if (platform === "win32") {
    const rootPid = child.pid;
    return {
      cancel: () => undefined,
      done: runWindowsProcessTreeKill(rootPid),
    };
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  let cancelForceKill = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      } finally {
        resolve();
      }
    }, posixForceKillGraceMs);
    forceKill.unref?.();
    cancelForceKill = (): void => {
      clearTimeout(forceKill);
      resolve();
    };
  });

  return { cancel: () => cancelForceKill(), done };
}
