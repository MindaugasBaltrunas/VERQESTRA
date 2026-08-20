// REALUS `IntegrationPort` kanoniniam loop'ui (etalonas: AG_loop task 0046, IVER-3 —
// orchestrator/adapters/integration-review-adapter.ts).
//
// `application/integration/review-integration.ts` yra grynas: jis žino, KADA semantinė peržiūra
// leidžiama ir ką reiškia jos verdiktas, bet neturi nei proceso, nei FS, nei biudžeto prieigos.
// Šis modulis yra vienintelė vieta, kur tie keturi efektai gauna realų įgyvendinimą, ir jis
// sąmoningai NEKURIA nė vieno naujo kanalo:
//
//   reviewer -> `claude-headless.ts#runClaudeHeadless` (tas pats paleidiklis, kurį naudoja
//               semantinė peržiūra), su `assertSafeModelId` prieš pat paleidimą;
//   budget   -> `token-governance#authorizeLlmCall` su `integration-review` faze;
//   usage    -> `state/token-usage-log.ts#logTokenUsage` su ta pačia faze;
//   repair   -> `state/task-repair-store.ts#writeTaskRepairPrompt` — tas pats failas, kurį
//               pasiima retry-bounded repair ciklas (`TaskRunPorts.repairPrompt.read`).
//
// TRYS savybės čia yra taisyklė, o ne įgyvendinimo detalė:
//
//   1. NEAIŠKUMAS NIEKADA NEVIRSTA PATVIRTINIMU. Nepavykęs kvietimas, 429 ar neišanalizuojamas
//      atsakymas grąžina `escalate`, o `escalate` yra human-review. `approve` gali atsirasti tik
//      iš modelio, kuris realiai atsakė ir aiškiai jį pasirinko.
//   2. TOKENAI NIEKADA NEDINGSTA IŠ SĄSKAITOS. Net kai kvietimas baigėsi klaida, iš envelope
//      atgautas usage grąžinamas kartu su `escalate` verdiktu, kad whole-task biudžetas
//      (TOK-4) matytų realiai sudegintus tokenus. Būtent todėl transporto klaida čia nėra
//      `throw`: išmesta klaida apskaitytų kvietimą be tokenų.
//   3. PROMPT'AS NEKURIAMAS ČIA. Į paleidiklį keliauja TIK `request.prompt`, kurį sukonstravo
//      `buildIntegrationReviewPrompt`. Jokio failų turinio, diff'o ar log uodegų.

import path from "node:path";
import {
  INTEGRATION_REVIEW_PHASE,
  parseIntegrationReviewResponse,
  type IntegrationReviewerRequest,
  type IntegrationReviewerResponse,
} from "../../application/integration/review-integration.js";
import type { IntegrationPort } from "../../application/task-execution/run-coordinator-ports.js";
import { authorizeLlmCall } from "../../application/token-governance/tool-budget-gates.js";
import { resolveMaxTurns } from "../../application/token-governance/turn-budget.js";
import { runClaudeHeadless } from "./claude-headless.js";
import { extractResultField, extractUsage, isUsageLimitOutput } from "./claude-usage.js";
import { assertSafeModelId, loadModelsEnv, resolveModelTier, type ModelsEnv, type ModelTier } from "./claude-model-env.js";
import { noRuntimeAttemptResolution, type AttemptResolutionPort } from "../state/attempt-resolution.js";
import { logTokenUsage } from "../state/token-usage-log.js";
import { createTokenBudgetGatePorts } from "../state/token-budget-gate-ports.js";
import { writeTaskRepairPrompt } from "../state/task-repair-store.js";

/**
 * Numatytoji peržiūros pakopa. Klausimas yra siauras ir vienkartinis (ar šie kontraktų
 * pokyčiai sulaužo savo vartotojus), o ne atviras architektūros sprendimas, tad brangesnė
 * pakopa čia nieko neatrakina; nepakankamas atsakymas vis tiek baigiasi human-review.
 */
export const DEFAULT_INTEGRATION_REVIEW_TIER: ModelTier = "sonnet";

/**
 * Kiek simbolių iš CLI klaidos patenka į verdikto santrauką. Santrauka keliauja į VIENĄ
 * human-review žurnalo eilutę, tad ji apkarpoma ir išlyginama į vieną eilutę.
 */
const MAX_FAILURE_SUMMARY_CHARS = 200;

export type IntegrationReviewAdapterDeps = {
  /** `vq` runtime šaknis (state/config/logs). VERQESTRA neturi ambient konteksto — privaloma. */
  runtimeRoot: string;
  tier?: ModelTier;
  /** Sesijos turn lubos; nenurodžius — bendra `semantic-review` fazės reikšmė. */
  maxTurns?: number;
  loadModelsEnv?: (runtimeRoot: string) => Promise<ModelsEnv>;
  runHeadless?: typeof runClaudeHeadless;
  authorize?: typeof authorizeLlmCall;
  recordUsage?: typeof logTokenUsage;
  writeRepairPrompt?: typeof writeTaskRepairPrompt;
  /** Usage įrašų attempt koreliacija; nenurodžius — be attempt tapatybės (best-effort). */
  resolution?: AttemptResolutionPort;
};

/** Viena eilutė: be naujų eilučių ir apkarpyta iki {@link MAX_FAILURE_SUMMARY_CHARS}. */
function oneLine(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > MAX_FAILURE_SUMMARY_CHARS
    ? `${flattened.slice(0, MAX_FAILURE_SUMMARY_CHARS)}…`
    : flattened;
}

/**
 * Kvietimas įvyko, bet naudingo atsakymo nedavė.
 *
 * Verdiktas visada `escalate` (t. y. human-review), o atgautas usage keliauja kartu — žr. šio
 * failo antraštės 1 ir 2 savybes.
 */
function failedInvocation(
  summary: string,
  model: string,
  usage: IntegrationReviewerResponse["usage"],
): IntegrationReviewerResponse {
  return {
    verdict: "escalate",
    summary: oneLine(summary),
    findings: [],
    model,
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Sukonstruoja realų integracijos peržiūros efektų paviršių kompozicijos šakniai.
 *
 * Visos priklausomybės (be runtimeRoot) turi numatytuosius produkcinius įgyvendinimus;
 * `deps` laukai egzistuoja tam, kad testai galėtų paduoti fake CLI ir fake biudžetą
 * nepaleisdami nė vieno proceso.
 */
export function createIntegrationReviewPort(deps: IntegrationReviewAdapterDeps): IntegrationPort {
  const runtimeRoot = deps.runtimeRoot;
  const tier = deps.tier ?? DEFAULT_INTEGRATION_REVIEW_TIER;
  // Tier'as turn lange nedalyvauja: `semantic-review` fazė turi savo eilutę turn lentelėje.
  const maxTurns = deps.maxTurns ?? resolveMaxTurns({ phase: "semantic-review", tier: "medium" });
  const loadModels = deps.loadModelsEnv ?? loadModelsEnv;
  const runHeadless = deps.runHeadless ?? runClaudeHeadless;
  const authorize = deps.authorize ?? authorizeLlmCall;
  const recordUsage = deps.recordUsage ?? logTokenUsage;
  const writeRepair = deps.writeRepairPrompt ?? writeTaskRepairPrompt;
  const resolution = deps.resolution ?? noRuntimeAttemptResolution;
  const gatePorts = createTokenBudgetGatePorts(runtimeRoot);

  return {
    reviewer: {
      async review(request: IntegrationReviewerRequest): Promise<IntegrationReviewerResponse> {
        const modelsEnv = await loadModels(runtimeRoot);
        // `resolveModelTier` jau validuoja ID, bet patikra kartojama ties pačiu paleidimu:
        // reikšmė iš čia interpoliuojama į PowerShell komandos eilutę (`runClaudeHeadless`),
        // tad saugos tikrinimas priklauso paleidimo vietai, o ne tam, kas ją išsprendė.
        const model = assertSafeModelId(resolveModelTier(tier, modelsEnv));

        const result = await runHeadless(request.prompt, model, path.join(runtimeRoot, "state"), {
          maxTurns,
          // Peržiūra grąžina TIK verdiktą — rašymo/vykdymo įrankių schemos jos kontekste yra
          // grynas svoris, apmokestinamas kiekviename turn'e (tas pats sprendimas kaip preflight).
          disallowWriteTools: true,
        });
        const usage = extractUsage(result.stdout);

        // 429/sesijos limitas yra infrastruktūra, bet peržiūros port'as infra kanalo neturi
        // (`IntegrationReviewerPort` grąžina tik verdiktą), tad jis parkuojamas su aiškia
        // priežastimi. Tylus praleidimas būtų blogiausias įmanomas šio varto elgesys.
        if (isUsageLimitOutput(result.stdout)) {
          return failedInvocation(`integration reviewer hit an API/session usage limit`, tier, usage);
        }
        if (result.code !== 0) {
          const detail = result.stderr.trim() || extractResultField(result.stdout);
          return failedInvocation(`integration reviewer exited ${result.code}: ${detail}`, tier, usage);
        }

        // Neišanalizuojamas atsakymas `parseIntegrationReviewResponse` viduje virsta `escalate`.
        const parsed = parseIntegrationReviewResponse(extractResultField(result.stdout));
        // Apskaitai rašoma pakopa, ne konkretus provider ID — taip `token-usage.jsonl` eilutė
        // sutampa su kitomis fazėmis (preflight/diagnose), kurios irgi žymi pakopą. Modelio
        // ATSAKYME nurodytas `model` čia sąmoningai ignoruojamas: kviestą pakopą žino kvietėjas,
        // ir apskaita negali priklausyti nuo to, ką apie save pasakė peržiūrimas atsakymas.
        return { ...parsed, model: tier, ...(usage === undefined ? {} : { usage }) };
      },
    },

    budget: {
      async authorize(request) {
        try {
          const authorization = await authorize(gatePorts, runtimeRoot, {
            taskId: request.taskId,
            phase: request.phase,
          });
          return { allowed: authorization.allowed, reasons: authorization.hard_reasons };
        } catch (error: unknown) {
          // Neįvertinamas biudžetas yra neaiškumas, o neaiškumas negali reikšti leidimo:
          // kvietimas neįvyksta ir peržiūra baigiasi human-review.
          return {
            allowed: false,
            reasons: [`budget could not be evaluated: ${error instanceof Error ? error.message : String(error)}`],
          };
        }
      },
    },

    usage: {
      async record(entry) {
        // `logTokenUsage` pati yra best-effort (viduje gaudo klaidas), tad verdiktas nuo
        // telemetrijos būklės nepriklauso — tą patį kontraktą deklaruoja ir `IntegrationReviewDeps`.
        await recordUsage({
          runtimeRoot,
          resolution,
          phase: INTEGRATION_REVIEW_PHASE,
          taskId: entry.taskId,
          model: entry.model,
          ...(entry.usage === undefined ? {} : { usage: entry.usage }),
          metadata: { outcome: entry.outcome },
        });
      },
    },

    async writeRepairPrompt(taskId: string, body: string): Promise<void> {
      await writeRepair(runtimeRoot, taskId, body);
    },
  };
}
