// `Stop` hook'o portai, kontekstas ir staging plano surinkimas (etalonas: AG_loop
// hooks/on-stop.ts IO pusė). Pats srautas — `on-stop.ts`; grynas sprendimas, kieno darbas
// patenka į commit'ą — `application/task-execution/session-stage-planning`.

import path from "node:path";
import type { GitAutomationPolicy } from "../../application/policy-governance/git-automation-policy.js";
import type { QualityGatesStatus } from "../../application/quality-gates/quality-gates-status.js";
import {
  planSessionStaging,
  type SessionStagingPlan,
} from "../../application/task-execution/session-stage-planning.js";
import type { SessionStartBaseline } from "../../application/task-execution/session-baseline.js";
import { sessionStartStatusPath } from "../../application/task-execution/session-baseline.js";
import type { TaskStartBaseline } from "../../application/task-execution/session-staging.js";
import {
  sessionWriteOwnersPath,
  type SessionWriteOwners,
} from "../../application/task-execution/session-write-owners.js";
import { parseJsonStringArray, tryParseJson } from "../../shared/json.js";
import { consoleHookIo, type HookFsPort, type HookIo } from "./protocol.js";
import type { StopGuardPorts } from "./stop-guards.js";

/** `git` komandos rezultatas, kiek jo reikia Stop hook'ui. */
export type StopCommandResult = { code: number; stdout: string; stderr: string };

export type StopCommitResult =
  | { ok: true; branch: string }
  | { ok: false; step: "add" | "commit" | "branch" | "push"; result: StopCommandResult };

export type StopHookFsPort = HookFsPort & {
  removeIfExists(absolutePath: string): Promise<void>;
};

export type StopHookPorts = StopGuardPorts & {
  fs: StopHookFsPort;
  env(name: string): string | undefined;
  now?: () => Date;
  /** Pakeisti produkto failai (changes.log + git status, runtime keliai atfiltruoti). */
  collectChangedFiles(projectRoot: string): Promise<string[]>;
  isGitRepository(projectRoot: string): Promise<boolean>;
  /** Ar medyje apskritai yra ką commit'inti. */
  hasGitChanges(projectRoot: string): Promise<boolean>;
  gitStatusPorcelain(projectRoot: string): Promise<StopCommandResult>;
  /** Gitignore'inti kandidatai: aiškus `git add -- <ignored>` klysta, skirtingai nei `--all`. */
  filterGitIgnored(paths: readonly string[], projectRoot: string): Promise<Set<string>>;
  commitAndPush(input: {
    projectRoot: string;
    message: string;
    paths: readonly string[];
    push: boolean;
  }): Promise<StopCommitResult>;
  /** Stop įrodymo tiltas orkestratoriui. Kviečiamas KIEKVIENOJE terminalinėje šakoje. */
  stopBridge(input: { status: string; reason: string; taskId: string }): Promise<void>;
  loadGitAutomationPolicy(runtimeRoot: string): Promise<GitAutomationPolicy>;
  readQualityGatesStatus(runtimeRoot: string): Promise<QualityGatesStatus | undefined>;
  /** Ar komanda pasiekiama PATH'e (`npx`). */
  commandExists(command: string): Promise<boolean>;
  runShell(command: string, cwd: string): Promise<StopCommandResult>;
  /**
   * Stop payload'as (`{ session_id, ... }`). NEPRIVALOMAS: be jo sesijos tapatybė lieka
   * nežinoma, ir guard'ai elgiasi taip, kaip iki 2026-08-24. Su juo `package-guard` gali
   * atskirti savo `package.json` pakeitimą nuo lygiagrečios sesijos darbo tame pačiame medyje.
   */
  readStdin?: () => Promise<string>;
};

export type StopHookDeps = {
  ports: StopHookPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: HookIo;
};

export type StopHookContext = {
  deps: StopHookDeps;
  io: HookIo;
  root: string;
  runtimeRoot: string;
  now(): Date;
  logPath(fileName: string): string;
  statePath(fileName: string): string;
  log(line: string): Promise<void>;
};

/** Stop hook'o blokuojantis exit kodas. */
export const STOP_BLOCK_EXIT_CODE = 2;
export const STOP_OK_EXIT_CODE = 0;

export function stopHookContext(deps: StopHookDeps): StopHookContext {
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
    log: async (line: string): Promise<void> => {
      await deps.ports.fs.appendTextFile(logPath("hooks.log"), `[${now().toISOString()}] ${line}\n`).catch(() => undefined);
    },
  };
}

export type StagePlanResult = {
  stagePaths: string[];
  /** Ledger'yje TRŪKSTAMI produkto failai, kuriuos išgelbėjo clean-baseline rescue. */
  rescued: string[];
  /** Ledger'io keliai, ĮRODYTAI priklausantys svetimai sesijai — palikti nestage'inti. */
  foreign: string[];
  /** Purvini produkto keliai, kuriuos grąžino ledger-gap saugiklis. */
  gap: string[];
};

async function readJsonObject<T>(fs: HookFsPort, filePath: string): Promise<T> {
  const raw = await fs.readTextFileIfExists(filePath);
  if (raw === undefined) return {} as T;
  const parsed = tryParseJson<unknown>(raw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return {} as T;
  }
  return parsed.value as T;
}

/**
 * Kuriuos kelius ši sesija gali stage'inti: ledger + lifecycle, minus gitignore'inti kandidatai.
 * VIENAS šaltinis ir pre-commit staging'ui, ir „ar apskritai yra ką commit'inti" patikrai — kad
 * abu niekada nesutartų skirtingai apie tai, ar užduotis pagamino commit'intiną darbą.
 */
export async function resolveStagePlan(context: StopHookContext, taskId: string): Promise<StagePlanResult> {
  const ports = context.deps.ports;
  const fs = ports.fs;
  const sessionWritesPath = context.statePath("session-writes.json");
  const stateDir = path.join(context.runtimeRoot, "state");

  const status = await ports.gitStatusPorcelain(context.root);
  const plan: SessionStagingPlan = planSessionStaging({
    statusOutput: status.stdout,
    sessionWrites: parseJsonStringArray(await fs.readTextFileIfExists(sessionWritesPath)),
    owners: await readJsonObject<SessionWriteOwners>(fs, sessionWriteOwnersPath(sessionWritesPath)),
    sessionBaseline: await readJsonObject<SessionStartBaseline>(fs, sessionStartStatusPath(stateDir)),
    taskBaseline: await readJsonObject<TaskStartBaseline>(fs, path.join(stateDir, "task-start-status.json")),
    taskId,
    dispatchNonce: (ports.env("AG_DISPATCH_NONCE") ?? "").trim(),
  });

  const ignored = await ports.filterGitIgnored(plan.paths, context.root);
  return {
    stagePaths: plan.paths.filter((candidate) => !ignored.has(candidate)),
    rescued: plan.ledgerMisses.filter((candidate) => !ignored.has(candidate)),
    foreign: plan.foreign,
    // Ta pati gitignore riba kaip visam planui: gap saugiklis prideda TIK tuos kelius, kurie ir
    // šiaip praeitų produkto klasifikaciją bei gitignore filtrą.
    gap: plan.gap.filter((candidate) => !ignored.has(candidate)),
  };
}
