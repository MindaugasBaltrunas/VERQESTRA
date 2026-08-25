// `claude-dispatch` portų surišimas (manual DI, LAY-2).
//
// Tai vienintelis kelias, kuris REALIAI paleidžia vykdytojo modelį. Interfaces sluoksnis
// infrastruktūros neimportuoja, tad visi infra gabalai (pristatymas, tool profilis, launcher,
// biudžeto watchdog, baigties normalizavimas, finalizavimas) ateina per šį failą — dažnai
// NEPERMATOMAIS handle'ais, kurių orkestratorius vidaus niekada neskaito.
//
// Handle'ų forma yra sąmoninga: `DispatchDeliveryHandle`/`DispatchWatchdogHandle` interfaces
// pusėje neturi jokių laukų, tad orkestratorius fiziškai negali priimti sprendimo pagal
// pristatymo ar watchdog'o vidų — jis gali tik perduoti juos atgal į kompoziciją.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { systemClock } from "../../application/context-pack/ports.js";
import {
  loadMcpCapabilityRegistry,
  unknownDispatchMcpCapabilities,
} from "../../application/context-pack/mcp-capability-registry.js";
import type { DispatchMcpCapabilities } from "../../application/context-pack/mcp-capability-registry.js";
import { authorizeLlmCall, type LlmCallAuthorization } from "../../application/token-governance/tool-budget-gates.js";
import {
  modelTierOfRoutingTier,
  resolveRoutedModel,
  routingTierOfSelection,
} from "../../infrastructure/adapters/claude-model-env.js";
import { loadModelsEnv } from "../../infrastructure/adapters/claude-model-env.js";
import {
  loadDispatchToolPolicyDecision,
  resolveDispatchPromptDelivery,
  resolveDispatchToolSchemaProfile,
  type DispatchPromptDelivery,
} from "../../infrastructure/adapters/claude-dispatch-delivery.js";
import { launchClaudeProcess } from "../../infrastructure/adapters/claude-dispatch-process.js";
import { createProjectContainment } from "../../infrastructure/fs/project-containment.js";
import { resolveDispatchOutcome } from "../../infrastructure/adapters/claude-dispatch-outcome.js";
import { finalizeDispatch } from "../../infrastructure/adapters/claude-dispatch-finalize.js";
import { claudeLastLogWriteFatal, writeClaudeLastLog } from "../../infrastructure/adapters/claude-last-log.js";
import { createMidDispatchBudgetWatchdog, type MidDispatchBudgetWatchdog } from "../../infrastructure/adapters/mid-dispatch-budget.js";
import { commandExists } from "../../infrastructure/process/run-process.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { resolveExistingDispatchTaskFile } from "../../infrastructure/state/dispatch-task-file.js";
import { ensureRuntimeDirs } from "../../infrastructure/state/runtime-dirs.js";
import { recordResumeCheckpoint } from "../../infrastructure/state/resume-checkpoint.js";
import type { AttemptResolutionPort } from "../../infrastructure/state/attempt-resolution.js";
import { taskLedgerKey } from "../../domain/tasks/identity.js";
import { tryParseJson } from "../../shared/json.js";
import type {
  ClaudeDispatchPorts,
  DispatchDecision,
  DispatchDeliveryHandle,
  DispatchToolPolicyView,
  DispatchWatchdogHandle,
  ResolveAttemptResult,
} from "../../interfaces/cli/dispatch/claude-dispatch/dispatch-ports.js";
import type { DispatchRoutingModelPorts } from "../../interfaces/cli/dispatch/claude-dispatch/dispatch-routing-plan.js";
import type { PrepareWorkerPromptDeps } from "../../interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.js";
import { parseJsonlObjects } from "../../application/learning/usage-view.js";
import { contextPackFs } from "../quality/readiness-adapters.js";
import { policyConfigFs, tokenBudgetPorts } from "../runtime/node-adapters.js";
import { readOptionalFile } from "../quality/diagnose-adapters.js";
import { loadProjectProfile } from "./preflight-adapters.js";
import { appendLogLine, readCurrentTaskId, retryCountsStore } from "../loop/adapters.js";

/** Modelio maršruto portai — provider pusė gyvena `claude-model-env`. */
export function dispatchModelPorts(runtimeRoot: string): DispatchRoutingModelPorts {
  return {
    routingTierOfSelection: (selected) => routingTierOfSelection(selected),
    modelTierOfRoutingTier: (tier) => modelTierOfRoutingTier(tier),
    resolveRoutedModel: async (tier) => resolveRoutedModel(tier, await loadModelsEnv(runtimeRoot)),
  };
}

/** Worker prompt'o paruošimo deps: context-pack fs, laikrodis ir task-events skaitymas. */
export function workerPromptDeps(runtimeRoot: string): PrepareWorkerPromptDeps {
  return {
    fs: contextPackFs,
    clock: systemClock,
    runtimeRoot,
    // Tolerantiškas skaitymas: sugadinta eilutė praleidžiama, o ne nutraukia dispatch'ą —
    // canary kohortos apskaita yra telemetrija, ne vartai.
    readTaskEvents: async () =>
      parseJsonlObjects(await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "task-events.jsonl"))),
  };
}

/** `pwsh.exe` / `powershell.exe`; POSIX platformose — `undefined`. */
export async function powerShellCommand(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  if (await commandExists("pwsh.exe")) return "pwsh.exe";
  return (await commandExists("powershell.exe")) ? "powershell.exe" : undefined;
}

export type ClaudeDispatchAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
  agRoot: string;
  resolution: AttemptResolutionPort;
};

/**
 * Visi `claude-dispatch` portai vienu pjūviu.
 *
 * `resolveAttempt` kol kas VISADA grąžina „be attempt'o" su įvardyta priežastimi. Loop'as JAU
 * migruotas ir pilnas resolveris (`activeAttemptResolution`) aptarnauja stop-hooks, diagnozę
 * ir telemetriją, bet dispatch attempt KANALAS (interfaces `DispatchAttemptView` closures virš
 * runtime-artifact-store, 1117a) dar neįvielintas — tai užfiksuotas nukrypimas nuo etalono
 * (migration-coverage.json, 2026-08-25). Tai NĖRA tylus praleidimas: įspėjimas keliauja į
 * dispatch žurnalą, artefaktai rašomi į globalius veidrodžius, o supervisor SPRENDIMAS
 * dispatch'ą pasiekia per `readSupervisorDecision` globalaus veidrodžio fallback'ą su
 * task_id nuosavybės patikra (0941 kanalas atkurtas 2026-08-25, auditas P0-1).
 */
export function claudeDispatchPorts(input: ClaudeDispatchAdapterInput): ClaudeDispatchPorts {
  const deliveries = new WeakMap<DispatchDeliveryHandle, DispatchPromptDelivery>();
  const watchdogs = new WeakMap<DispatchWatchdogHandle, MidDispatchBudgetWatchdog>();
  // Vienas containment visam dispatch'ui: šaknies `realpath` suskaičiuojamas kartą.
  const dispatchContainment = createProjectContainment(input.projectRoot);

  return {
    projectRoot: input.projectRoot,
    runtimeRoot: input.runtimeRoot,

    ensureDirs: () => ensureRuntimeDirs(input.agRoot, input.runtimeRoot),
    resolveExistingTaskFile: (taskFileArg) => resolveExistingDispatchTaskFile(input.projectRoot, taskFileArg),
    readOptionalFile: (absolutePath) => readOptionalFile(absolutePath),
    writeText: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
    removeIfExists: (absolutePath) => nodeFsAdapter.removeIfExists(absolutePath),
    readCurrentTaskId: async () => (await readCurrentTaskId(input.runtimeRoot)) ?? "",
    readRetryCounts: () => retryCountsStore(input.runtimeRoot).read(),

    resolveAttempt: (attemptInput): Promise<ResolveAttemptResult> =>
      Promise.resolve({
        warnings: [
          `runtime attempt namespace unavailable task=${taskLedgerKey(attemptInput.taskFile)} reason=no-runtime` +
            " — artifacts fall back to global mirrors",
        ],
      }),

    // Nuosavybės taisyklė ta pati kaip `coordinator-adapters.readDecision`, bet griežtesnė
    // kryptimi: veidrodis be `task_id` čia NEPRIIMAMAS (preflight jį rašo visada, tad jo
    // nebuvimas reiškia ne mūsų rašytą failą), o svetimas `task_id` yra pasenęs įrašas —
    // `foreign`, ne klaida.
    readSupervisorDecision: async (taskId) => {
      const raw = await nodeFsAdapter.readTextFileIfExists(path.join(input.runtimeRoot, "supervisor", "decision.json"));
      if (raw === undefined || raw.trim() === "") return { kind: "missing" };
      const parsed = tryParseJson<unknown>(raw);
      if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        return { kind: "invalid", errors: [parsed.ok ? "decision.json is not a JSON object" : parsed.error.message] };
      }
      const decision = parsed.value as DispatchDecision;
      const owner = typeof decision.task_id === "string" ? decision.task_id.trim() : "";
      if (owner === "" || owner.toLowerCase() !== taskId.trim().toLowerCase()) return { kind: "foreign" };
      return { kind: "ok", decision };
    },

    policyFs: policyConfigFs,
    workerPromptDeps: workerPromptDeps(input.runtimeRoot),
    authorizeLlmCall: (taskId, phase): Promise<LlmCallAuthorization> =>
      authorizeLlmCall(tokenBudgetPorts(input.runtimeRoot), input.runtimeRoot, { taskId, phase }),
    models: dispatchModelPorts(input.runtimeRoot),
    loadProjectProfile: () => loadProjectProfile(input.runtimeRoot),

    powerShellCommand: () => powerShellCommand(),
    // Išjungtas flag'as neturi daryti NĖ VIENO papildomo skaitymo — jam reikia tuščio
    // pjūvio be I/O, o ne „perskaityk ir ignoruok".
    mcpCapabilities: (enabled): Promise<DispatchMcpCapabilities> =>
      enabled
        ? loadMcpCapabilityRegistry(contextPackFs, input.runtimeRoot)
        : Promise.resolve(unknownDispatchMcpCapabilities("dispatch_tool_schema disabled")),
    loadToolPolicy: async (): Promise<DispatchToolPolicyView> => {
      const decision = await loadDispatchToolPolicyDecision(policyConfigFs, input.runtimeRoot);
      return {
        ...(decision.browser === undefined ? {} : { browser: decision.browser }),
        ...(decision.scraper === undefined ? {} : { scraper: decision.scraper }),
        ...(decision.mcp === undefined ? {} : { mcp: decision.mcp }),
      };
    },
    resolveToolSchemaProfile: (profileInput) => resolveDispatchToolSchemaProfile(profileInput),

    resolveDelivery: (deliveryInput) => {
      const delivery = resolveDispatchPromptDelivery(deliveryInput);
      const handle: DispatchDeliveryHandle = {};
      deliveries.set(handle, delivery);
      return { view: { platform: delivery.platform, transport: delivery.transport }, handle };
    },

    createBudgetWatchdog: (watchdogInput) => {
      // `limitSource` porte yra `string` (interfaces neimportuoja infra tipų), o infra jo
      // laukia siauro. Susiaurinimas vyksta ČIA — vienoje vietoje, matomas.
      const watchdog = createMidDispatchBudgetWatchdog({
        ...watchdogInput,
        limitSource: watchdogInput.limitSource === "task-remaining" ? "task-remaining" : "dispatch-ceiling",
      });
      const handle: DispatchWatchdogHandle = {};
      watchdogs.set(handle, watchdog);
      return handle;
    },

    launchProcess: async (launchInput) => {
      const delivery = deliveries.get(launchInput.delivery);
      const watchdog = watchdogs.get(launchInput.budgetWatchdog);
      // Nepažįstamas handle reikštų, kad orkestratorius perdavė ne mūsų sukurtą objektą —
      // tai programavimo klaida, o ne runtime būsena, tad ji garsi.
      if (delivery === undefined || watchdog === undefined) {
        throw new Error("claude-dispatch: unknown delivery or watchdog handle");
      }
      return await launchClaudeProcess({
        delivery,
        visibleLauncher: launchInput.visibleLauncher,
        projectRoot: input.projectRoot,
        model: launchInput.model,
        claudeExitFile: launchInput.claudeExitFile,
        ...(launchInput.attemptClaudeLog === undefined ? {} : { attemptClaudeLog: launchInput.attemptClaudeLog }),
        claudeLog: launchInput.claudeLog,
        logChannels: {
          ...(launchInput.attemptClaudeLog === undefined ? {} : { attemptPath: launchInput.attemptClaudeLog }),
          globalPath: launchInput.claudeLog,
        },
        dispatchTimeoutMs: launchInput.dispatchTimeoutMs,
        ...(launchInput.dispatchMaxTurns === undefined ? {} : { dispatchMaxTurns: launchInput.dispatchMaxTurns }),
        dispatchNonce: launchInput.dispatchNonce,
        toolSchema: launchInput.toolSchema,
        budgetWatchdog: watchdog,
        budgetAbortSignal: launchInput.budgetAbortSignal,
        taskId: launchInput.taskId,
        logDispatch: (line) => launchInput.logDispatch(line),
        onWindowsInitialLog: (write) => launchInput.onWindowsInitialLog(write),
      });
    },

    readFileBytesIfExists: async (absolutePath) => {
      // Baitai, ne tekstas: BOM ar ne-UTF8 turinys per tekstinį skaitymą iškraipytų hash'ą ir
      // duotų KLAIDINGĄ „pasenęs" verdiktą — o toks verdiktas čia reiškia atsisakytą dispatch'ą.
      //
      // Kelias ateina iš context-pack `symbol.file`, t. y. iš artefakto, kurį gali sugadinti ar
      // suklastoti. Todėl tas pats containment kaip visur, kur diskas liečiamas pagal task'o
      // duotus duomenis: symlink'as projekto viduje, rodantis į išorę, leksinio varto nepraeina.
      // Už ribų vedantis kelias grąžina `undefined`, o `undefined` šviežumo skaičiuotojui
      // reiškia PASENĘS — tad nukreipimas baigiasi atmetimu, ne tyliu skaitymu.
      if ((await dispatchContainment.containedOrUndefined(absolutePath)) === undefined) return undefined;
      if ((await nodeFsAdapter.statKind(absolutePath)) !== "file") return undefined;
      try {
        return await nodeFsAdapter.readFileBytes(absolutePath);
      } catch {
        return undefined;
      }
    },

    readClaudeLastLog: async (logInput) => {
      if (logInput.attemptPath !== undefined) {
        const attemptText = await nodeFsAdapter.readTextFileIfExists(logInput.attemptPath);
        if (attemptText !== undefined) return attemptText;
      }
      return (await nodeFsAdapter.readTextFileIfExists(logInput.globalPath)) ?? "";
    },

    resolveOutcome: async (outcomeInput) => {
      const watchdog = watchdogs.get(outcomeInput.budgetWatchdog);
      if (watchdog === undefined) throw new Error("claude-dispatch: unknown watchdog handle");
      return await resolveDispatchOutcome({
        runtimeRoot: input.runtimeRoot,
        taskId: outcomeInput.taskId,
        initialExitCode: outcomeInput.initialExitCode,
        claudeLogText: outcomeInput.claudeLogText,
        dispatchNonce: outcomeInput.dispatchNonce,
        budgetWatchdog: watchdog,
        budgetAborted: outcomeInput.budgetAborted,
        tokenBudget: outcomeInput.tokenBudget,
        sessionElapsedMs: outcomeInput.sessionElapsedMs,
        dispatchTimeoutMs: outcomeInput.dispatchTimeoutMs,
        ...(outcomeInput.readAttemptStopState === undefined
          ? {}
          : { readAttemptStopState: outcomeInput.readAttemptStopState }),
        logDispatch: (line) => outcomeInput.logDispatch(line),
      });
    },

    finalize: (finalizeInput) =>
      finalizeDispatch({
        runtimeRoot: input.runtimeRoot,
        taskId: finalizeInput.taskId,
        taskFile: finalizeInput.taskFile,
        dispatchPhase: finalizeInput.dispatchPhase,
        attempt: finalizeInput.attempt,
        effectiveTier: finalizeInput.effectiveTier,
        routingReasonCodes: finalizeInput.routingReasonCodes,
        claudeExitFile: finalizeInput.claudeExitFile,
        claudeLog: finalizeInput.claudeLog,
        ...(finalizeInput.attemptClaudeLog === undefined ? {} : { attemptClaudeLog: finalizeInput.attemptClaudeLog }),
        claudeLogText: finalizeInput.claudeLogText,
        toolSchema: finalizeInput.toolSchema,
        launchRecord: finalizeInput.launchRecord,
        outcome: finalizeInput.outcome as Parameters<typeof finalizeDispatch>[0]["outcome"],
        recordExecutionResult: (record) => finalizeInput.recordExecutionResult(record),
        recordResumeCheckpoint: (entry) =>
          recordResumeCheckpoint({
            projectRoot: input.projectRoot,
            runtimeRoot: input.runtimeRoot,
            resolution: input.resolution,
            checkpoint: entry,
          }),
        resolution: input.resolution,
        logDispatch: (line) => finalizeInput.logDispatch(line),
      }),

    logWriteFatal: (view) => claudeLastLogWriteFatal({ ...view, errors: [...view.errors] }),
    recordResumeCheckpoint: (entry) =>
      recordResumeCheckpoint({
        projectRoot: input.projectRoot,
        runtimeRoot: input.runtimeRoot,
        resolution: input.resolution,
        checkpoint: entry,
      }),
    agLog: (line) => appendLogLine(input.runtimeRoot, "orchestrator.log", line),
    stderr: (line) => process.stderr.write(`${line}\n`),

    // Nonce yra SESIJOS TAPATYBĖ: pagal jį stop-bridge skiria savo „done" nuo svetimo. Todėl
    // jis kriptografiškai atsitiktinis, o ne laiko antspaudas — du tuo pačiu momentu paleisti
    // dispatch'ai gautų tą patį ir vienas prisiimtų kito įrodymą.
    newDispatchNonce: () => randomBytes(16).toString("hex"),
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

export { writeClaudeLastLog };
