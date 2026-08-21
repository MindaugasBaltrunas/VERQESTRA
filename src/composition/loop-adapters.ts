// Loop ir dispatch klasterio adapteriai (manual DI, LAY-2): einamojo task'o žymės, retry
// skaitikliai, klaidų parašai, žurnalai ir stop-bridge rašymas.
//
// Šie adapteriai aptarnauja komandas, kurias kviečia NE operatorius, o loop skriptas ir
// Claude hook'ai. Iš to plaukia bendra taisyklė: nė vienas jų neturi teisės nutraukti kelio
// dėl savo buhalterijos — trūkstamas failas visada yra atsakymas, o ne klaida.

import path from "node:path";
import type { RetryCountsStorePort, SupervisorRetryDecision } from "../application/task-execution/retry-counts.js";
import { loadAgentPolicy } from "../application/policy-governance/agent-policy.js";
import type { LoopPreconditionPorts } from "../application/scheduling/loop-preconditions.js";
import type { SchedulingFileSystemPort } from "../application/scheduling/ports.js";
import { reapDeadWorkerLeases } from "../application/scheduling/worker-lease-runtime.js";
import type { AgentPolicy } from "../domain/policies/agent-selection.js";
import type { ExecutionAdapter, ExecutionAdapterKind } from "../domain/agents/execution-port.js";
import { ClaudeAdapter } from "../infrastructure/adapters/claude-adapter.js";
import { CodexAdapter } from "../infrastructure/adapters/codex-adapter.js";
import { DryRunAdapter } from "../infrastructure/adapters/dry-run-adapter.js";
import { runExecutionDispatch, type ExecutionDispatchResult } from "../infrastructure/adapters/execution-dispatch.js";
import { parseEnvFile } from "../interfaces/http/ui-port-store.js";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";
import { findStaleDistFiles } from "../infrastructure/process/dist-freshness.js";
import { gitCommitExists, gitStatusPorcelain, isGitRepository } from "../infrastructure/git/git-client.js";
import { run } from "../infrastructure/process/run-process.js";
import { stopBridgeForProject } from "../infrastructure/state/stop-bridge.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { toPrettyJson, tryParseJson } from "../shared/json.js";
import { policyConfigFs } from "./node-adapters.js";

/** `vq/state/current-task-id` — vienintelė vieta, kur loop'as žymi einamąjį task'ą. */
export function currentTaskIdPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "current-task-id");
}

/** Einamojo task'o id; `undefined`, kai žymės nėra (loop'as dar nepradėjo). */
export async function readCurrentTaskId(runtimeRoot: string): Promise<string | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(currentTaskIdPath(runtimeRoot));
  const value = raw?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Retry skaitiklių saugykla. Sugadintas failas skaitomas kaip TUŠČIAS žemėlapis: kitaip vienas
 * neparsinamas baitas užrakintų retry vartus visam repo — o vartai, kurie negali suskaičiuoti,
 * privalo leisti bandymą, ne jį amžinai blokuoti.
 */
export function retryCountsStore(runtimeRoot: string): RetryCountsStorePort {
  const file = path.join(runtimeRoot, "state", "retry-counts.json");
  return {
    read: async () => {
      const raw = await nodeFsAdapter.readTextFileIfExists(file);
      if (raw === undefined) return {};
      const parsed = tryParseJson<Record<string, number>>(raw);
      return parsed.ok && parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    },
    write: (counts) => nodeFsAdapter.writeTextFile(file, toPrettyJson(counts)),
  };
}

/** Vienos JSON būsenos skaitymas su `{}` fallback'u — trūkstamas/sugadintas failas nėra klaida. */
async function readJsonOrEmpty<T extends object>(absolutePath: string): Promise<T> {
  const raw = await nodeFsAdapter.readTextFileIfExists(absolutePath);
  if (raw === undefined) return {} as T;
  const parsed = tryParseJson<T>(raw);
  return parsed.ok && parsed.value !== null && typeof parsed.value === "object" ? parsed.value : ({} as T);
}

/** Vienos eilutės append į `vq/logs/<name>` su laiko antspaudu (etalono `agLog` forma). */
export function appendLogLine(runtimeRoot: string, name: string, line: string): Promise<void> {
  const stamp = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  return nodeFsAdapter.appendTextFile(path.join(runtimeRoot, "logs", name), `[${stamp}] ${line}\n`);
}

export type RetryGuardAdapters = {
  readDecision(): Promise<SupervisorRetryDecision>;
  counts: RetryCountsStorePort;
  maxRetriesPerError(): Promise<number>;
  readCurrentTaskId(): Promise<string | undefined>;
  readErrorSignatures(): Promise<Record<string, string>>;
  writeErrorSignatures(signatures: Record<string, string>): Promise<void>;
  writeLegacyErrorSignature(text: string): Promise<void>;
  agLog(line: string): Promise<void>;
  appendErrorLog(text: string): Promise<void>;
};

/** Etalono default'as: kiek kartų tas pats klaidos parašas gali kartotis prieš human-review. */
export const DEFAULT_MAX_RETRIES_PER_ERROR = 2;

/**
 * `MAX_RETRIES_PER_ERROR` iš `vq/config/commands.env`.
 *
 * Netinkama reikšmė (ne skaičius, neigiama) krenta į default'ą, o ne meta: retry vartai yra
 * SAUGIKLIS, ir konfigo klaida negali jo išjungti — be limito task'as ciklintų neribotai.
 */
export async function maxRetriesPerError(runtimeRoot: string): Promise<number> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "config", "commands.env"));
  const value = Number.parseInt(parseEnvFile(raw ?? "")["MAX_RETRIES_PER_ERROR"]?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_RETRIES_PER_ERROR;
}

/** `retry-guard` portai: sprendimas, skaitikliai, parašai ir du žurnalai. */
export function retryGuardAdapters(runtimeRoot: string): RetryGuardAdapters {
  const statePath = (name: string): string => path.join(runtimeRoot, "state", name);
  return {
    readDecision: () => readJsonOrEmpty<SupervisorRetryDecision>(path.join(runtimeRoot, "supervisor", "decision.json")),
    counts: retryCountsStore(runtimeRoot),
    maxRetriesPerError: () => maxRetriesPerError(runtimeRoot),
    readCurrentTaskId: () => readCurrentTaskId(runtimeRoot),
    readErrorSignatures: () => readJsonOrEmpty<Record<string, string>>(statePath("last-error-signatures.json")),
    writeErrorSignatures: (signatures) =>
      nodeFsAdapter.writeTextFile(statePath("last-error-signatures.json"), toPrettyJson(signatures)),
    writeLegacyErrorSignature: (text) => nodeFsAdapter.writeTextFile(statePath("last-error-signature"), text),
    agLog: (line) => appendLogLine(runtimeRoot, "orchestrator.log", line),
    // Klaidų žurnalas gauna PARUOŠTUS blokus (kelios eilutės) — antspaudas jiems netaikomas.
    appendErrorLog: (text) => nodeFsAdapter.appendTextFile(path.join(runtimeRoot, "logs", "error.log"), text),
  };
}

/**
 * `on-stop-bridge`: einamojo task'o id ir stop įrodymo rašymas.
 *
 * `readCurrentTaskId` čia grąžina `""` (ne `undefined`), nes komanda tokį kontraktą deklaruoja:
 * interaktyvi sesija be task'o vis tiek privalo parašyti globalų veidrodį — tik be attempt
 * artefakto. Attempt rezoliucija ateina portu; pilnas resolveris atvyks su loop kompozicija.
 */
export function onStopBridgeAdapters(
  projectRoot: string,
  runtimeRoot: string,
): { readCurrentTaskId(): Promise<string>; writeStopBridge(status: string, reason: string, taskId: string): Promise<void> } {
  return {
    readCurrentTaskId: async () => (await readCurrentTaskId(runtimeRoot)) ?? "",
    writeStopBridge: (status, reason, taskId) =>
      stopBridgeForProject({
        projectRoot,
        runtimeRoot,
        resolution: noRuntimeAttemptResolution,
        status,
        reason,
        taskId,
      }),
  };
}

/**
 * Vykdymo adapterio fabrikas su `enabled` vartais.
 *
 * `enabled` galioja TIK `codex` rūšiai ir tik tada, kai kvietėjas jį aiškiai perduoda: codex
 * adapteris be jo yra inertiškas ir grąžina „not implemented", o ne bando kviesti išorinį
 * įrankį. Tai gyvas saugiklis, ne formalumas — `verqestra dispatch --adapter codex` be
 * eksplicitinio kelio niekada nepaleidžia realaus proceso.
 */
export function createAdapterWithOptions(kind: ExecutionAdapterKind, options?: { enabled?: boolean }): ExecutionAdapter {
  if (kind === "dry-run") return new DryRunAdapter();
  if (kind === "claude") return new ClaudeAdapter();
  if (kind === "codex") return new CodexAdapter({ enabled: options?.enabled === true });
  const exhaustive: never = kind;
  throw new Error(`Unknown execution adapter: ${String(exhaustive)}`);
}

/** `dispatch` portai: task tekstas, agentų politika, adapterio fabrikas ir vartais saugomas vykdymas. */
export function dispatchAdapters(
  projectRoot: string,
  runtimeRoot: string,
): {
  readTaskText(taskFile: string): Promise<string>;
  loadAgentPolicy(): Promise<AgentPolicy>;
  createAdapter(kind: ExecutionAdapterKind): ExecutionAdapter;
  runDispatch(taskFile: string, adapter: ExecutionAdapter): Promise<ExecutionDispatchResult>;
} {
  return {
    // Neperskaitomas task'as duoda TUŠČIĄ tekstą (etalono semantika): maršrutizavimas tada
    // krenta į politikos default'ą, o ne griūva — pats dispatch'as vis tiek tikrina vartus.
    readTaskText: async (taskFile) =>
      (await nodeFsAdapter.readTextFileIfExists(path.isAbsolute(taskFile) ? taskFile : path.join(projectRoot, taskFile))) ?? "",
    loadAgentPolicy: () => loadAgentPolicy(policyConfigFs, runtimeRoot),
    createAdapter: (kind) => createAdapterWithOptions(kind),
    runDispatch: (taskFile, adapter) => runExecutionDispatch({ taskFile, projectRoot, runtimeRoot, adapter }),
  };
}

/** Scheduling FS portas (lease saugykla, lock katalogai) — vienas visiems planuotojo keliams. */
export const schedulingFs: SchedulingFileSystemPort = {
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  listDirectoryIfExists: (absoluteDir) => nodeFsAdapter.listDirectoryIfExists(absoluteDir),
  writeTextFileAtomic: (absolutePath, content) => nodeFsAdapter.writeTextFileAtomic(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  createLockDirectory: (absoluteDir) => nodeFsAdapter.createLockDirectory(absoluteDir),
  removeDirectory: (absoluteDir) => nodeFsAdapter.removeDirectory(absoluteDir),
  directoryModifiedAtMs: (absoluteDir) => nodeFsAdapter.directoryModifiedAtMs(absoluteDir),
};

/**
 * `.git` katalogo kelias.
 *
 * Klausiama git'o, o ne spėjama `<root>/.git`: worktree ir submodule atvejais `.git` yra
 * FAILAS su nuoroda, ir spėjimas ten rastų ne tą katalogą — o būtent jame ieškoma pakibusio
 * `index.lock`. Nepavykęs kvietimas grąžina `undefined` („nežinau"), ne klaidą.
 */
export async function resolveGitDir(projectRoot: string): Promise<string | undefined> {
  const result = await run("git", ["-C", projectRoot, "rev-parse", "--git-dir"], { cwd: projectRoot });
  if (result.code !== 0) return undefined;
  const dir = result.stdout.trim();
  if (dir === "") return undefined;
  return path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
}

/** `loop-guard` prielaidų portai: git būsena, dist šviežumas ir failų skaitymas. */
export function loopPreconditionPorts(): LoopPreconditionPorts {
  return {
    isGitRepository: (projectRoot) => isGitRepository(projectRoot),
    // Portas prašo `{code, stdout}` formos: `code !== 0` reiškia „git nepasiekiamas", ir tai
    // NE tas pats, kas švarus medis — sulietas atsakymas paverstų gedimą sėkme.
    gitStatusPorcelain: async (projectRoot) => {
      const stdout = await gitStatusPorcelain(projectRoot);
      return stdout === undefined ? { code: 1, stdout: "" } : { code: 0, stdout };
    },
    resolveGitDir: (projectRoot) => resolveGitDir(projectRoot),
    fileMtimeMs: (absolutePath) => nodeFsAdapter.fileMtimeMs(absolutePath),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    gitCommitExists: (ref, projectRoot) => gitCommitExists(ref, projectRoot),
    findStaleDistFiles: (packageRoot) => findStaleDistFiles(packageRoot),
  };
}

/**
 * Higienos žingsnis prieš vartus: mirusių savininkų lease'ų nuėmimas.
 *
 * Tai NE vartai — grąžinamos eilutės tik pasakoja, kas buvo sutvarkyta, ir niekada nekeičia
 * verdikto. Klaida čia praryjama: nepavykęs valymas negali blokuoti loop'o, kurį jis turėjo
 * tik palengvinti.
 */
export async function reapDeadLeases(projectRoot: string, now: Date): Promise<string[]> {
  try {
    return await reapDeadWorkerLeases({ fs: schedulingFs }, projectRoot, { now });
  } catch {
    return [];
  }
}
