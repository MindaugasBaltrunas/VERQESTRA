// Bendras SessionStart/SessionEnd hook'ų kontekstas: portai, keliai ir žurnalo eilutė.
// Atskirtas nuo pačių hook'ų, nes abu naudoja tą patį portų rinkinį ir tuos pačius kelius.

import path from "node:path";
import type { DispatchCheckpointView } from "../../application/task-execution/session-baseline.js";
import type { LoopRuntimeFsPort } from "./loop-runtime-store.js";
import { consoleHookIo, type HookFsPort, type HookIo, type HookStdinPort } from "./protocol.js";

export type SessionHookFsPort = HookFsPort &
  LoopRuntimeFsPort & {
    /** Absoliutūs `.md` keliai kataloge; nesamas katalogas — tuščias sąrašas. */
    listMarkdownFiles(absoluteDir: string): Promise<string[]>;
    renamePath(fromPath: string, toPath: string): Promise<void>;
  };

export type SessionHookPorts = {
  fs: SessionHookFsPort;
  stdin: HookStdinPort;
  /**
   * Ar hook'as paleistas interaktyviai (TTY). Tada stdin skaityti NEGALIMA: rankinis
   * paleidimas hook payload'o neturi, o skaitymas kabintų procesą amžinai.
   */
  stdinIsInteractive(): boolean;
  processIsAlive(pid: number): boolean;
  /** Hook'o tėvinis PID — sesijos proceso kandidatas (žr. `resolveSessionOwnerPid`). */
  parentPid(): number;
  env(name: string): string | undefined;
  /** `git status --porcelain --untracked-files=all` projekto šaknyje. */
  gitStatusPorcelain(projectRoot: string): Promise<{ code: number; stdout: string }>;
  /** Dispatch resume checkpoint'o pjūvis; nesamas ar neperskaitomas — `undefined`. */
  readDispatchCheckpoint(stateDir: string): Promise<DispatchCheckpointView | undefined>;
  /** Šiuo metu nešvarūs failai (changes.log + git status, runtime keliai atfiltruoti). */
  collectChangedFiles(projectRoot: string): Promise<string[]>;
  /** Sesijos santraukos komandos paleidimas; grąžina exit kodą. */
  runSessionSummary(projectRoot: string): Promise<number>;
  now?: () => Date;
};

export type SessionHookDeps = {
  ports: SessionHookPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: HookIo;
};

export type SessionHookContext = {
  deps: SessionHookDeps;
  io: HookIo;
  root: string;
  runtimeRoot: string;
  now(): Date;
  logPath(fileName: string): string;
  statePath(fileName: string): string;
  log(line: string): Promise<void>;
};

/** Sėkmingo sesijos ciklo hook'o exit kodas — kitokio čia nėra. */
export const SESSION_HOOK_OK_EXIT_CODE = 0;

/** Vartotojo Claude terminalo runtime įrašo kelias (PASYVUS buvimo indikatorius). */
export function userClaudePidFile(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "user-claude.pid");
}

export function sessionHookContext(deps: SessionHookDeps): SessionHookContext {
  const io = deps.io ?? consoleHookIo;
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const now = (): Date => deps.ports.now?.() ?? new Date();
  const logPath = (fileName: string): string => path.join(runtimeRoot, "logs", fileName);
  return {
    deps,
    io,
    root,
    runtimeRoot,
    now,
    logPath,
    statePath: (fileName: string): string => path.join(runtimeRoot, "state", fileName),
    // Žurnalo rašymas NIEKADA nemeta: sesijos startas ar pabaiga negali lūžti dėl žurnalo.
    log: async (line: string): Promise<void> => {
      await deps.ports.fs
        .appendTextFile(logPath("hooks.log"), `[${now().toISOString()}] ${line}\n`)
        .catch(() => undefined);
    },
  };
}

/**
 * Ar ši sesija yra loop'o dispatch'inta (headless), o ne vartotojo terminalas.
 *
 * Skiriamasis požymis — dispatch nonce, kurį į sesijos aplinką deda TIK dispatch'as (ta pati
 * konvencija, kuria stop-bridge atskiria savo „done" nuo svetimo). Interaktyvi sesija jo neturi.
 */
export function isDispatchedClaudeSession(ports: SessionHookPorts): boolean {
  return Boolean(ports.env("AG_DISPATCH_NONCE")?.trim());
}

export function dispatchNonceOf(ports: SessionHookPorts): string {
  return (ports.env("AG_DISPATCH_NONCE") ?? "").trim();
}
