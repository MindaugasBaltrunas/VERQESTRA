// Cheap finish adapteris (manual DI, LAY-2): durabli žymė, retry biudžeto būklė ir naujo bandymo
// paruošimas.
//
// Cheap finish yra VIENKARTINĖ išimtis: kai vienintelė likusi klaida yra mechaninė
// (typecheck/test), produkto darbas jau egzistuoja, o task'ą stabdo biudžeto lubos arba retry
// limitas, loop'as gauna vieną pigų bandymą užbaigti. Iš to plaukia visos šio failo taisyklės:
//
//   - ŽYMĖ (`vq/state/cheap-finish/<task>.json`) NIEKADA netrinama, o sugadintas jos turinys vis
//     tiek reiškia `armed`: pats failo egzistavimas ir yra „cheap finish jau panaudotas" įrodymas;
//   - žymės RAŠYMO klaida negali paversti išimties task'o gedimu — adapteris totalus (tik įrašas
//     žurnale). Vieno karto garantiją tuo pačiu run'u laiko ir retry skaitiklio inkrementas;
//   - `prepareDispatch` fail-closed PRIEŠ retry inkrementą: be attempt namespace'o nėra kur
//     paskelbti nei biudžeto pakopos, nei modelio, tad cheap finish netektų būtent tų ribų, dėl
//     kurių jis apskritai leidžiamas;
//   - modelis renkamas per `routeModel` kaip ORAKULĄ, o ne perrašant maršrutą: ieškoma žemiausios
//     explicit pakopos, kurią maršrutizatorius su tais pačiais įėjimais paverčia norima galutine.
//     Kitaip cheap finish ir `claude-dispatch` išsiskirtų.

import path from "node:path";
import type { CheapFinishMarker, CheapFinishPort } from "../application/task-execution/run-coordinator-ports.js";
import { incrementTaskRetryCount } from "../application/task-execution/retry-counts.js";
import { evaluateRetryLimit } from "../domain/tasks/index.js";
import { AUTO_ESCALATION_CEILING, loadRoutingPolicy, ROUTING_TIERS, routeModel } from "../application/token-governance/route-model.js";
import { routingTierRank, type RoutingTier } from "../domain/tokens/routing-tier.js";
import { modelTierOfRoutingTier } from "../infrastructure/adapters/claude-model-env.js";
import { DECISION_TOKEN_BUDGET_TIER_KEY } from "../application/token-governance/tiers.js";
import { recordLlmCallReset } from "../application/token-governance/tool-budget-gates.js";
import { measureTaskSize } from "../domain/tasks/size.js";
import { resolveActiveAttempt } from "../infrastructure/state/active-attempt.js";
import { writeAttemptJsonWithRetry } from "../infrastructure/persistence/runtime-artifact-store.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { toPrettyJson, tryParseJson } from "../shared/json.js";
import { appendLogLine, maxRetriesPerError, retryCountsStore } from "./loop-adapters.js";
import { policyConfigFs, tokenBudgetPorts } from "./node-adapters.js";

export type CheapFinishAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
};

/**
 * Vienkartinis env overlay sekančiam dispatch'ui.
 *
 * Kūnas pasikeitė, tad senas `execution-context.md` nebeatitinka fingerprint'o —
 * `AG_EXECUTION_CONTEXT_MODE=required` verčia jį regeneruoti. Overlay SUNAUDOJAMAS pirmo tinkamo
 * kvietimo: antras dispatch'as jo nebemato, ir cheap finish lengvatos nepaveldi.
 */
export type CheapFinishEnvOverlay = {
  arm(taskId: string): void;
  /** Grąžina overlay TIK vieną kartą; po to jis dingsta. */
  consume(): Record<string, string> | undefined;
};

export function createCheapFinishEnvOverlay(): CheapFinishEnvOverlay {
  let pending: { taskId: string } | undefined;
  return {
    arm: (taskId) => {
      pending = { taskId };
    },
    consume: () => {
      if (pending === undefined) return undefined;
      pending = undefined;
      return { AG_EXECUTION_CONTEXT_MODE: "required" };
    },
  };
}

function markerPath(runtimeRoot: string, taskId: string): string {
  return path.join(runtimeRoot, "state", "cheap-finish", `${taskId}.json`);
}

/** Ankstesnio bandymo maršruto pakopa; be įrodymo — `standard` (vidurinė, ne aukščiausia). */
async function previousRoutingTier(runtimeRoot: string, projectRoot: string, taskId: string): Promise<RoutingTier> {
  const current = await resolveActiveAttempt({ taskId, projectRoot, runtimeRoot });
  if (!current.ok) return "standard";
  const result = await current.attempt.handle.readJson<{ routing?: { tier?: unknown } }>("execution-result");
  const tier = result.ok ? result.data.routing?.tier : undefined;
  return typeof tier === "string" && (ROUTING_TIERS as readonly string[]).includes(tier) ? (tier as RoutingTier) : "standard";
}

/** `selected_model` cheap finish bandymui: VIENAS laiptelis virš ankstesnės pakopos. */
async function selectedModelFor(input: {
  runtimeRoot: string;
  promptText: string;
  failedAttempts: number;
  previousTier: RoutingTier;
}): Promise<string> {
  const target =
    ROUTING_TIERS[Math.min(routingTierRank(AUTO_ESCALATION_CEILING), routingTierRank(input.previousTier) + 1)] ??
    AUTO_ESCALATION_CEILING;
  const metrics = measureTaskSize(input.promptText);
  const policy = await loadRoutingPolicy(policyConfigFs, input.runtimeRoot).catch(() => undefined);
  const size = {
    lines: metrics.lines,
    allowedPaths: metrics.allowedPaths,
    domains: metrics.domains,
    actionBullets: metrics.actionBullets,
  };

  for (const candidate of ROUTING_TIERS) {
    const routed = routeModel({
      phase: "implementation",
      taskText: input.promptText,
      selectedTier: candidate,
      failedAttempts: input.failedAttempts,
      size,
      ...(policy === undefined ? {} : { policy }),
    });
    if (routed.tier === target) return modelTierOfRoutingTier(candidate);
  }
  // Orakulas nerado explicit pakopos, duodančios būtent norimą rezultatą (pvz. operatorius
  // eskalaciją išjungė): imamas pats tikslas — jis niekada nėra aukščiau automatinių lubų.
  return modelTierOfRoutingTier(target);
}

export function cheapFinishPort(input: CheapFinishAdapterInput, overlay: CheapFinishEnvOverlay): CheapFinishPort {
  const { projectRoot, runtimeRoot } = input;
  const log = (message: string): Promise<void> => appendLogLine(runtimeRoot, "orchestrator.log", message);

  return {
    async read(taskId) {
      const raw = await nodeFsAdapter.readTextFileIfExists(markerPath(runtimeRoot, taskId)).catch(() => undefined);
      if (raw === undefined) return { status: "absent" };

      const parsed = tryParseJson<CheapFinishMarker>(raw);
      if (!parsed.ok) {
        // Sugadintas turinys NEPANAIKINA fakto, kad failas egzistuoja — fail-closed.
        await log(`WARNING: cheap finish marker invalid JSON task=${taskId}: ${parsed.error.message}`);
        return { status: "armed" };
      }
      return { status: "armed", record: parsed.value };
    },

    async arm(record) {
      try {
        const file = markerPath(runtimeRoot, record.task_id);
        await nodeFsAdapter.makeDirectory(path.dirname(file));
        await nodeFsAdapter.writeTextFileAtomic(file, toPrettyJson(record));
      } catch (error) {
        // Adapteris TOTALUS: žymės rašymo klaida negali paversti išimties task'o gedimu.
        await log(`WARNING: cheap finish marker not recorded task=${record.task_id}: ${describe(error)}`);
      }
    },

    async retryBudget(taskId) {
      const counts = await retryCountsStore(runtimeRoot).read();
      const raw = counts[`task:${taskId}`];
      const count = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
      // TA PATI aritmetika kaip retry vartuose: skaitiklis didinamas PRIEŠ dispatch'ą, tad
      // „kitas bandymas" yra `count + 1`.
      const next = evaluateRetryLimit(count + 1, await maxRetriesPerError(runtimeRoot));
      return { count, max: next.max, nextWouldReachLimit: next.reached };
    },

    async prepareDispatch(request) {
      const errors: string[] = [];
      const failed = (): { ok: false; attemptSequence: 0; selectedModel: ""; errors: string[] } => ({
        ok: false,
        attemptSequence: 0,
        selectedModel: "",
        errors,
      });

      const current = await resolveActiveAttempt({ taskId: request.taskId, projectRoot, runtimeRoot });
      if (!current.ok && (current.reason === "disabled" || current.reason === "no-runtime")) {
        // Fail-closed PRIEŠ retry inkrementą — būsena lieka nepajudinta.
        errors.push(`runtime attempt namespace unavailable: ${current.reason}`);
        return failed();
      }
      const previousTier = await previousRoutingTier(runtimeRoot, projectRoot, request.taskId);

      let failedAttempts: number;
      try {
        // Inkrementas yra ir saugiklis (antras cheap finish tam pačiam task'ui atsimuštų į retry
        // limitą), ir būtinybė: `a<n>` = f(skaitiklis), o konteksto artefaktai yra write-once.
        failedAttempts = (await incrementTaskRetryCount(retryCountsStore(runtimeRoot), request.taskId, "cheap-finish")).taskCount;
      } catch (error) {
        errors.push(`retry counter not incremented: ${describe(error)}`);
        return failed();
      }

      const selectedModel = await selectedModelFor({
        runtimeRoot,
        promptText: request.promptText,
        failedAttempts,
        previousTier,
      });

      const prepared = await resolveActiveAttempt({
        taskId: request.taskId,
        projectRoot,
        runtimeRoot,
        create: true,
        manifest: { policy: { selected_model: selectedModel, cheap_finish: true }, source: { origin: "repair-task" } },
      });
      if (!prepared.ok) {
        errors.push(`attempt not created: ${prepared.reason}: ${prepared.errors.join("; ")}`);
        return failed();
      }

      // Sprendimas naujam bandymui: modelio bazė maršrutizatoriui ir turn lango pakopa — abu
      // skaito dispatch'as iš ŠIO įrašo.
      const written = await writeAttemptJsonWithRetry(prepared.attempt.handle, "decision", {
        verdict: "delegate",
        task_id: request.taskId,
        selected_model: selectedModel,
        reason: "cheap-finish",
        [DECISION_TOKEN_BUDGET_TIER_KEY]: request.tokenBudgetTier,
      });
      if (!written.ok) {
        errors.push(`attempt decision not written: ${written.reason}: ${written.errors.join("; ")}`);
        return failed();
      }

      if (request.resetTaskLedger) {
        try {
          // VIENINTELIS mechanizmas, atidarantis naują biudžeto epochą: be jo kvietimo vartai
          // atmestų dispatch'ą dar prieš sesiją, ir cheap finish liktų teorija.
          await recordLlmCallReset(tokenBudgetPorts(runtimeRoot), request.taskId);
        } catch (error) {
          errors.push(`llm call reset not recorded: ${describe(error)}`);
          return failed();
        }
      }

      overlay.arm(request.taskId);
      return { ok: true, attemptSequence: failedAttempts + 1, selectedModel, errors };
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
