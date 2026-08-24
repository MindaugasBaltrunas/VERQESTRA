// Proceso medžio nužudymas su verifikacija. Elgesio etalonas: AG_loop core/process-tree.ts
// (2026-07-07 audito P1: helper'iai, viršiję biudžetą apkrautoje mašinoje, būdavo nužudomi
// įpusėję, o funkcija grįždavo „sėkmingai" palikusi visą užtimeout'intą medį gyvą).

import { spawn, type ChildProcess } from "node:child_process";

export type KillTreeResult = {
  cancel: () => void;
  /**
   * Baigties pažadas, grąžinantis PID'us, kurie LIKO GYVI (2026-08-24).
   *
   * Tuščias sąrašas = medis tikrai miręs. POSIX kelyje jis visada tuščias: ten žudoma proceso
   * GRUPĖ, tad atskiro medžio patikrinimo nereikia — grupės signalas yra autoritetas.
   */
  done: Promise<number[]>;
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

/**
 * Kaip `runIgnoredProcess`, bet grąžina stdout. Reikalinga TIK medžio sąrašui: pats žudymas
 * išvesties neskaito, ir jam `stdio: "ignore"` lieka teisingas.
 */
function runCapturingProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      // Nepavykęs SĄRAŠAS negali nutraukti žudymo: tuščias sąrašas reiškia „medžio nežinome",
      // ir tada verifikuojamas bent root — lygiai kaip iki 2026-08-24.
      finish("");
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", () => finish(""));
    child.on("close", () => finish(output));
  });
}

/**
 * Viso medžio PID'ai (be paties root), surinkti PRIEŠ žudymą.
 *
 * Po žudymo šito padaryti NEĮMANOMA: mirus tėvui, vaikai persikabina prie kito proceso, ir
 * apėjimas nuo root jų nebesuranda. Todėl sąrašas fiksuojamas iš anksto ir tik paskui tikrinamas.
 */
export function listWindowsProcessTreePids(
  rootPid: number,
  timeoutMs: number = helperKillTimeoutMs,
): Promise<number[]> {
  const script = `
$root = ${rootPid}
$seen = @{}
$queue = New-Object System.Collections.Queue
$queue.Enqueue([int]$root)
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
while ($queue.Count -gt 0) {
  $parent = [int]$queue.Dequeue()
  foreach ($proc in $procs | Where-Object { $_.ParentProcessId -eq $parent }) {
    $id = [int]$proc.ProcessId
    if (-not $seen.ContainsKey($id)) {
      $seen[$id] = $true
      Write-Output $id
      $queue.Enqueue($id)
    }
  }
}
`;
  return runCapturingProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    timeoutMs,
  ).then((output) =>
    output
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
  );
}

/**
 * Verifikuojamas tree-kill. Grąžina PID'us, kurie po visų bandymų LIKO GYVI.
 *
 * 2026-08-24 (operatoriaus sprendimas): verifikuojamas VISAS medis, ne tik root. Iki tol ciklas
 * baigdavosi ties `!alive(rootPid)`, tad palikuonys — atsiradę po WMI nuotraukos, persikabinę
 * arba sąmoningai atsijungę — likdavo nepatikrinti, ir funkcija grįždavo tylia „sėkme", nors
 * agentas galėjo toliau suktis ir naudoti biudžetą.
 *
 * Tai NĖRA Job Object pakaitalas: lenktynės tarp nuotraukos ir žudymo lieka, ir procesas,
 * gimęs PO sąrašo surinkimo, čia nebus pastebėtas. Bet tylus nepavykimas tampa MATOMAS —
 * grąžintas sąrašas keliauja į timeout/abort žinutę, tad operatorius mato konkrečius PID'us,
 * o ne tuščią „nužudyta".
 */
export async function runWindowsProcessTreeKill(
  rootPid: number,
  runner: IgnoredProcessRunner = runIgnoredProcess,
  alive: (pid: number) => boolean = isProcessAlive,
  listTree: (rootPid: number, timeoutMs?: number) => Promise<number[]> = listWindowsProcessTreePids,
): Promise<number[]> {
  // Sąrašas imamas PRIEŠ pirmą bandymą — po jo medžio nebeatkursi.
  const descendants = await listTree(rootPid, helperKillTimeoutMs).catch(() => []);
  const targets = [...new Set([rootPid, ...descendants])];

  let survivors: number[] = targets;
  for (let attempt = 0; attempt < treeKillMaxAttempts; attempt += 1) {
    const budgetMs = helperKillTimeoutMs * 2 ** attempt;
    const powershellOk = await runWindowsPowerShellTreeKill(rootPid, runner, budgetMs);
    if (!powershellOk) {
      await runWindowsTaskKill(rootPid, runner, budgetMs);
    }
    survivors = targets.filter((pid) => alive(pid));
    if (survivors.length === 0) {
      return [];
    }
  }
  return survivors;
}

export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): KillTreeResult {
  if (child.pid === undefined) return { cancel: () => undefined, done: Promise.resolve([]) };

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
  // POSIX: žudoma proceso GRUPĖ, tad atskiro medžio patikrinimo nereikia — grupės signalas
  // pasiekia visus narius, ir „likusiųjų" sąvokos čia nėra.
  const done = new Promise<number[]>((resolve) => {
    const forceKill = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      } finally {
        resolve([]);
      }
    }, posixForceKillGraceMs);
    forceKill.unref?.();
    cancelForceKill = (): void => {
      clearTimeout(forceKill);
      resolve([]);
    };
  });

  return { cancel: () => cancelForceKill(), done };
}
