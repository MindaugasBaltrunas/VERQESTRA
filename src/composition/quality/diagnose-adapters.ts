// `claude-diagnose` portų surišimas (manual DI, LAY-2).
//
// Diagnozė yra SIBLING procesas: ji paleidžiama po to, kai vykdytojo sesija jau baigėsi, tad
// jos aplinka nebeturi nei gyvo `AG_DISPATCH_NONCE` (Windows'e jo ten nė nebuvo), nei atviro
// vykdytojo konteksto. Iš to plaukia visa šio failo laikysena: kiekvienas įrodymas skaitomas
// ATTEMPT-FIRST su legacy veidrodžiu tik kaip atsarga, o kiekvienas nesėkmingas skaitymas
// virsta TUŠČIA reikšme, ne klaida — diagnozė privalo pasakyti verdiktą būtent tada, kai
// aplinkui viskas sugriuvę.

import path from "node:path";
import { qualityGatesStatusPath, type QualityGatesStatus } from "../../application/quality-gates/quality-gates-status.js";
import { loadPreflightLimits } from "../../application/policy-governance/preflight-limits-policy.js";
import { authorizeLlmCall, type LlmCallAuthorization } from "../../application/token-governance/tool-budget-gates.js";
import type { TurnLimits } from "../../application/token-governance/turn-budget.js";
import { sessionWriteOwnersPath, type SessionWriteOwners } from "../../application/task-execution/session-write-owners.js";
import { taskLedgerKey } from "../../domain/tasks/identity.js";
import type { ClaudeDiagnosePorts } from "../../interfaces/cli/dispatch/claude-diagnose/diagnose-ports.js";
import { resolveExistingDispatchTaskFile } from "../../infrastructure/state/dispatch-task-file.js";
import { ensureRuntimeDirs } from "../../infrastructure/state/runtime-dirs.js";
import { recordResumeCheckpoint } from "../../infrastructure/state/resume-checkpoint.js";
import { appendLogLine } from "../loop/adapters.js";
import { extractDecisionJson } from "../../infrastructure/adapters/claude-decision.js";
import { runClaudeHeadless } from "../../infrastructure/adapters/claude-headless.js";
import {
  escalateModelTier,
  loadModelsEnv,
  resolveModelTier,
} from "../../infrastructure/adapters/claude-model-env.js";
import { claudeModelSelectionRules } from "../../infrastructure/adapters/claude-headless.js";
import { extractResultField, extractUsage, isUsageLimitOutput } from "../../infrastructure/adapters/claude-usage.js";
import {
  gitHead,
  gitStatus,
  gitLogSince,
} from "../../infrastructure/git/git-client.js";
import { run } from "../../infrastructure/process/run-process.js";
import { productPathsFromDiffNames } from "../../domain/git/changes.js";
import { windowProductWorkSha } from "../../infrastructure/git/work-evidence.js";
import { consoleCliIo, type CliIo } from "../../interfaces/cli/registry.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { attemptLogPath } from "../../infrastructure/runtime-paths.js";
import type { AttemptResolutionPort } from "../../infrastructure/state/attempt-resolution.js";
import { readStopEvidence } from "../../infrastructure/state/stop-evidence.js";
import { logTokenUsage } from "../../infrastructure/state/token-usage-log.js";
import { tryParseJson, parseJsonStringArray } from "../../shared/json.js";
import { policyConfigFs, tokenBudgetPorts } from "../runtime/node-adapters.js";

/** Skaitymas, kuris NIEKADA nemeta: nesamas ar neperskaitomas failas duoda tuščią tekstą. */
export async function readOptionalFile(absolutePath: string): Promise<string> {
  return (await nodeFsAdapter.readTextFileIfExists(absolutePath)) ?? "";
}

/** JSON objektas arba `{}` — sugadinta būsena diagnozės nenutraukia. */
async function readJsonObject<T extends object>(absolutePath: string): Promise<T> {
  const raw = await nodeFsAdapter.readTextFileIfExists(absolutePath);
  if (raw === undefined) return {} as T;
  const parsed = tryParseJson<T>(raw);
  return parsed.ok && parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value)
    ? parsed.value
    : ({} as T);
}

/**
 * Produkto keliai, pakeisti `base..HEAD` lange.
 *
 * `--name-only --format=` duoda vien failų sąrašą; nepavykęs kvietimas grąžina TUŠČIĄ sąrašą,
 * o ne klaidą — „nežinau, kas pasikeitė" diagnozei reiškia „įrodymo nėra", ir tai griežtesnė
 * pusė nei nutraukti visą sprendimą.
 */
export async function changedProductPathsSince(projectRoot: string, baseHead: string): Promise<string[]> {
  const result = await run("git", ["-C", projectRoot, "diff", "--name-only", `${baseHead}..HEAD`], { cwd: projectRoot });
  return result.code === 0 ? productPathsFromDiffNames(result.stdout) : [];
}

/**
 * Vykdytojo sesijos žurnalas: ATTEMPT kanalas su legacy veidrodžiu kaip atsarga.
 *
 * Kilmė grąžinama kartu su tekstu, nes operatoriui tai skirtingi dalykai: `attempt` reiškia
 * „šio bandymo žurnalas", `legacy` — „paskutinis bet kurios sesijos žurnalas", ir antruoju
 * atveju tekstas gali priklausyti visai kitam task'ui.
 */
export async function readClaudeSessionLog(
  runtimeRoot: string,
  taskId: string,
  resolution: AttemptResolutionPort,
): Promise<{ origin: string; text: string }> {
  if (taskId.trim() !== "") {
    const resolved = await resolution.resolveActiveAttempt(taskId);
    if (resolved.ok) {
      const target = attemptLogPath(runtimeRoot, resolved.attempt.handle.ref, "claude-last");
      if (target.ok) {
        const raw = await nodeFsAdapter.readTextFileIfExists(target.value);
        if (raw !== undefined) return { origin: "attempt", text: raw };
      }
    }
  }
  const legacy = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "claude-last.log"));
  return legacy === undefined ? { origin: "none", text: "" } : { origin: "legacy", text: legacy };
}

/**
 * Attempt-only `task-start-status`. Bet kuri ne-ok baigtis duoda `{}` (fail-closed).
 *
 * Tai NĖRA nutylėjimas: tuščia bazė uždaro įrodymų langą, tad klaida veda į PILNĄ diagnozę,
 * o ne į greitkelį „matyt viskas gerai".
 */
export async function readTaskStartStatus(
  taskId: string,
  resolution: AttemptResolutionPort,
): Promise<{ task_id?: string; base_head?: string }> {
  if (taskId.trim() === "") return {};
  const resolved = await resolution.resolveActiveAttempt(taskId);
  if (!resolved.ok) return {};
  const read = await resolved.attempt.handle.readJson<{ task_id?: string; base_head?: string }>("task-start-status");
  return read.ok ? read.data : {};
}

/** Diagnozės modelis: haiku bazė, pakelta pagal nesėkmingų bandymų skaičių. */
export async function resolveDiagnosisModel(runtimeRoot: string, failedAttempts: number): Promise<string> {
  return resolveModelTier(escalateModelTier("haiku", failedAttempts), await loadModelsEnv(runtimeRoot));
}

/** Turn ribos diagnozei — iš tos pačios preflight limits politikos. */
export async function loadDiagnoseLimits(
  runtimeRoot: string,
): Promise<{ turnLimits?: TurnLimits; llmMaxTurns: number }> {
  const limits = await loadPreflightLimits(policyConfigFs, runtimeRoot);
  return {
    ...(limits.turnLimits === undefined ? {} : { turnLimits: limits.turnLimits }),
    llmMaxTurns: limits.llmMaxTurns,
  };
}

/** Sesijos rašymų ledger'is su nuosavybės sidecar'u; `present=false`, kai ledger'io nėra. */
export async function readSessionWrites(
  runtimeRoot: string,
): Promise<{ present: boolean; writes: string[]; owners: SessionWriteOwners }> {
  const writesPath = path.join(runtimeRoot, "state", "session-writes.json");
  const raw = await nodeFsAdapter.readTextFileIfExists(writesPath);
  // `present` skiriamas nuo tuščio sąrašo SĄMONINGAI: „ledger'io nėra" reiškia, kad hook'ai
  // nesuveikė, o „ledger'is tuščias" — kad sesija nieko nerašė. Diagnozei tai priešingos išvados.
  return {
    present: raw !== undefined,
    writes: parseJsonStringArray(raw),
    owners: await readJsonObject<SessionWriteOwners>(sessionWriteOwnersPath(writesPath)),
  };
}

export type DiagnoseAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
  resolution: AttemptResolutionPort;
  env?: NodeJS.ProcessEnv;
  /** Kvietėjo išvestis; be jos — konsolė. Testai ir auditas paduoda savo. */
  io?: CliIo;
};

/** Git pjūvis diagnozei — visi keliai grąžina reikšmę, o ne klaidą. */
export function diagnoseGitPorts(input: DiagnoseAdapterInput): {
  status(): Promise<string>;
  head(): Promise<string | undefined>;
  logSince(baseHead: string | undefined): Promise<string>;
  changedProductPathsSince(baseHead: string): Promise<string[]>;
} {
  return {
    status: () => gitStatus(input.projectRoot),
    head: () => gitHead(input.projectRoot),
    logSince: (baseHead) => gitLogSince(baseHead, input.projectRoot),
    changedProductPathsSince: (baseHead) => changedProductPathsSince(input.projectRoot, baseHead),
  };
}

/** LLM pjūvis: biudžeto vartai, modelis, headless kvietimas ir sprendimo parsinimas. */
export function diagnoseLlmPorts(input: DiagnoseAdapterInput): {
  authorizeLlmCall(taskId: string): Promise<LlmCallAuthorization>;
  resolveDiagnosisModel(failedAttempts: number): Promise<string>;
  modelSelectionRules: string;
  runHeadless(
    prompt: string,
    model: string,
    options: { maxTurns: number; disallowWriteTools: true },
  ): Promise<{ stdout: string; stderr: string; code: number }>;
  parseDecision(stdout: string): ReturnType<typeof extractDecisionJson>;
  isUsageLimitOutput(stdout: string): boolean;
  logTokenUsage(phase: string, model: string, stdout?: string): Promise<void>;
} {
  return {
    authorizeLlmCall: (taskId) =>
      authorizeLlmCall(tokenBudgetPorts(input.runtimeRoot), input.runtimeRoot, { taskId, phase: "diagnosis" }),
    resolveDiagnosisModel: (failedAttempts) => resolveDiagnosisModel(input.runtimeRoot, failedAttempts),
    modelSelectionRules: claudeModelSelectionRules,
    runHeadless: async (prompt, model, options) => {
      // State katalogas runtime šaknyje: win32 šakoje ten atsiranda prompt'o tmp failas, ir
      // projekto medyje jis atrodytų kaip agento darbas.
      const stateDir = path.join(input.runtimeRoot, "state");
      await nodeFsAdapter.makeDirectory(stateDir);
      const previousCwd = process.cwd();
      try {
        process.chdir(input.projectRoot);
        return await runClaudeHeadless(prompt, model, stateDir, {
          maxTurns: options.maxTurns,
          disallowWriteTools: options.disallowWriteTools,
        });
      } finally {
        process.chdir(previousCwd);
      }
    },
    // Du sluoksniai: `extractResultField` išima `result` lauką iš `--output-format json` voko,
    // `extractDecisionJson` — sprendimo objektą iš to teksto. Praleistas pirmas sluoksnis
    // parsintų patį voką ir sprendimo niekada nerastų.
    parseDecision: (stdout) => extractDecisionJson(extractResultField(stdout)),
    isUsageLimitOutput: (stdout) => isUsageLimitOutput(stdout),
    logTokenUsage: (phase, model, stdout) => {
      // `extractUsage` gali grąžinti `undefined` ir esant stdout (vokas be usage bloko) —
      // tada laukas praleidžiamas visai: `usage: undefined` reikštų „išmatuota, ir nulis",
      // o tai kita išvada nei „nepamatuota".
      const usage = stdout === undefined ? undefined : extractUsage(stdout);
      return logTokenUsage({
        runtimeRoot: input.runtimeRoot,
        resolution: input.resolution,
        phase,
        taskId: "",
        model,
        ...(usage === undefined ? {} : { usage }),
      });
    },
  };
}

/** Būsenos skaitymai: vartai, stop įrodymas, retry skaitikliai, parašai, sesijos rašymai. */
export function diagnoseStatePorts(input: DiagnoseAdapterInput): {
  readGatesStatus(): Promise<QualityGatesStatus | undefined>;
  readStopEvidence(taskId: string): ReturnType<typeof readStopEvidence>;
  readRetryCounts(): Promise<Record<string, number>>;
  readRetryCountsRaw(): Promise<string>;
  readErrorSignatures(): Promise<Record<string, string>>;
  readLegacyErrorSignature(): Promise<string>;
  readSessionWrites(): ReturnType<typeof readSessionWrites>;
  readCurrentTaskId(): Promise<string>;
  envDispatchNonce(): string;
  windowProductWorkSha(taskId: string): Promise<string | undefined>;
} {
  const statePath = (name: string): string => path.join(input.runtimeRoot, "state", name);
  const env = input.env ?? process.env;

  return {
    readGatesStatus: async () => {
      const raw = await nodeFsAdapter.readTextFileIfExists(qualityGatesStatusPath(input.runtimeRoot));
      if (raw === undefined) return undefined;
      const parsed = tryParseJson<QualityGatesStatus>(raw);
      return parsed.ok ? parsed.value : undefined;
    },
    readStopEvidence: (taskId) =>
      readStopEvidence({ runtimeRoot: input.runtimeRoot, resolution: input.resolution, taskId, env }),
    readRetryCounts: () => readJsonObject<Record<string, number>>(statePath("retry-counts.json")),
    // Žalias JSON keliauja į prompt'ą: modelis mato TIKSLIAI tą patį dokumentą, kurį matė
    // vartai — perrašytas per objektą jis būtų kitas tekstas.
    readRetryCountsRaw: () => readOptionalFile(statePath("retry-counts.json")),
    readErrorSignatures: () => readJsonObject<Record<string, string>>(statePath("last-error-signatures.json")),
    readLegacyErrorSignature: () => readOptionalFile(statePath("last-error-signature")),
    readSessionWrites: () => readSessionWrites(input.runtimeRoot),
    readCurrentTaskId: async () => (await readOptionalFile(statePath("current-task-id"))).trim(),
    // Sibling procese nonce jau ištrintas — tuščia eilutė yra normali, o ne gedimas.
    envDispatchNonce: () => (env["AG_DISPATCH_NONCE"] ?? "").trim(),
    windowProductWorkSha: (taskId) =>
      windowProductWorkSha({ projectRoot: input.projectRoot, taskId, resolution: input.resolution }),
  };
}

/** Rašymo pjūvis: attempt artefaktai ir globalūs veidrodžiai. */
export function diagnoseWritePorts(input: DiagnoseAdapterInput & { taskId: string }): {
  attempt: {
    writeDecision(decision: unknown): Promise<void>;
    appendRepairPrompt(text: string): Promise<void>;
    appendDiagnosisInput(text: string): Promise<void>;
  };
  files: {
    writeDecision(json: string): Promise<void>;
    writeRepairPrompt(scoped: string): Promise<void>;
    writeGlobalRepair(scoped: string): Promise<void>;
    writeDiagnosisInput(text: string): Promise<void>;
    writeSupervisorLog(text: string): Promise<void>;
  };
} {
  const supervisor = (name: string): string => path.join(input.runtimeRoot, "supervisor", name);

  const withAttempt = async (action: (handle: { appendLog(channel: string, line: string): Promise<unknown> }) => Promise<void>): Promise<void> => {
    if (input.taskId.trim() === "") return;
    const resolved = await input.resolution.resolveActiveAttempt(input.taskId);
    if (!resolved.ok) return;
    // Attempt artefaktai yra BEST-EFFORT: jų klaida negali sugriauti diagnozės, kurios
    // rezultatas jau apskaičiuotas ir turi pasiekti globalius veidrodžius.
    try {
      await action(resolved.attempt.handle);
    } catch {
      // tylima sąmoningai
    }
  };

  return {
    attempt: {
      writeDecision: (decision) =>
        withAttempt(async (handle) => {
          await handle.appendLog("decision", JSON.stringify(decision));
        }),
      appendRepairPrompt: (text) =>
        text.trim() === ""
          ? Promise.resolve()
          : withAttempt(async (handle) => {
              await handle.appendLog("repair-prompt", text);
            }),
      appendDiagnosisInput: (text) =>
        withAttempt(async (handle) => {
          await handle.appendLog("diagnosis-input", text);
        }),
    },
    files: {
      writeDecision: (json) => nodeFsAdapter.writeTextFile(supervisor("decision.json"), json),
      writeRepairPrompt: (scoped) =>
        nodeFsAdapter.writeTextFile(path.join(input.runtimeRoot, "state", "repair", `${input.taskId}.md`), scoped),
      writeGlobalRepair: (scoped) => nodeFsAdapter.writeTextFile(supervisor("repair-task.md"), scoped),
      writeDiagnosisInput: (text) => nodeFsAdapter.writeTextFile(supervisor("diagnosis-input.md"), text),
      writeSupervisorLog: (text) =>
        nodeFsAdapter.writeTextFile(path.join(input.runtimeRoot, "logs", "supervisor-last.log"), text),
    },
  };
}

/**
 * Visi `claude-diagnose` portai vienu pjūviu.
 *
 * Task id čia yra LAZY: rašymo keliai (`state/repair/<id>.md`) jo reikalauja, bet jis gimsta tik
 * iš argumento išspręsto task failo. Komandos kontraktas garantuoja tvarką —
 * `resolveExistingTaskFile` kviečiamas PRIEŠ bet kokį rašymą, ir kol jis nepavyko, komanda
 * grįžta su usage klaida. Todėl reikšmė užpildoma būtent ten, o ne spėjama iš `current-task-id`:
 * globalus žymeklis gali priklausyti visai kitam, lygiagrečiai bėgančiam task'ui.
 */
export function claudeDiagnosePorts(input: DiagnoseAdapterInput & { agRoot: string }): ClaudeDiagnosePorts {
  let taskId = "";
  const writes = (): ReturnType<typeof diagnoseWritePorts> => diagnoseWritePorts({ ...input, taskId });

  return {
    projectRoot: input.projectRoot,
    runtimeRoot: input.runtimeRoot,
    ensureDirs: () => ensureRuntimeDirs(input.agRoot, input.runtimeRoot),
    resolveExistingTaskFile: async (taskFileArg) => {
      const resolved = await resolveExistingDispatchTaskFile(input.projectRoot, taskFileArg);
      taskId = taskLedgerKey(resolved);
      return resolved;
    },
    readOptionalFile: (absolutePath) => readOptionalFile(absolutePath),
    git: diagnoseGitPorts(input),
    ...diagnoseStatePorts(input),
    readStopEvidence: async () => {
      const evidence = await diagnoseStatePorts(input).readStopEvidence(taskId);
      return {
        origin: evidence.origin,
        ...(evidence.status === undefined ? {} : { status: evidence.status }),
        ...(evidence.taskId === undefined ? {} : { taskId: evidence.taskId }),
        raw: evidence.raw,
        record: evidence.record,
        corrupted: evidence.corrupted,
        warnings: evidence.warnings,
      };
    },
    readClaudeSessionLog: () => readClaudeSessionLog(input.runtimeRoot, taskId, input.resolution),
    readTaskStartStatus: () => readTaskStartStatus(taskId, input.resolution),
    ...diagnoseLlmPorts(input),
    loadDiagnoseLimits: () => loadDiagnoseLimits(input.runtimeRoot),
    get attempt() {
      return writes().attempt;
    },
    get files() {
      return writes().files;
    },
    recordResumeCheckpoint: (entry) =>
      recordResumeCheckpoint({
        projectRoot: input.projectRoot,
        runtimeRoot: input.runtimeRoot,
        resolution: input.resolution,
        checkpoint: entry,
      }),
    agLog: (line) => appendLogLine(input.runtimeRoot, "orchestrator.log", line),
    // Klaidos eina per TĄ PATĮ `io`, kurį gavo registras: tiesioginis `process.stderr` rašymas
    // reikštų, kad viena komanda nepaklūsta kvietėjo išvesčiai (o auditas jos net nepamatytų).
    stderr: (line) => (input.io ?? consoleCliIo).error(line),
  };
}
