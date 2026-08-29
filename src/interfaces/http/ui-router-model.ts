// Dashboard'o maršrutizatoriaus TIPAI ir bendri atsakymų konstruktoriai.
//
// Atskiras failas dėl aciklinio importų grafo: `ui-router` (vartai + GET) ir
// `ui-router-mutations` (POST) abu remiasi tomis pačiomis portų ir atsakymų formomis, o vienas
// kito importuoti negali — tipai keliauja į `-model` failą (repo konvencija).

import type { HttpErrorResponse } from "./ui-error-mapping.js";
import type { PolicyProposalGroup } from "../../application/policy-governance/policy-file-registry.js";
import type { RequestHeaders } from "./ui-security.js";
import type { TaskTriageAction } from "./ui-task-actions.js";

export type UiRouteRequest = {
  method: string;
  /** Žalias URL su query — maršrutui reikia ir kelio, ir parametrų. */
  url: string;
  headers: RequestHeaders;
  /** JSON kūnas; per didelis kūnas META, ir tai virsta 413, ne 500. */
  readJsonBody(): Promise<unknown>;
  /** Žalias kūnas įkėlimui (jį parsina `task-upload`). */
  readRawBody(): Promise<string>;
};

export type UiRouteResponse =
  | { kind: "json"; status: number; data: unknown }
  | { kind: "text"; status: number; text: string }
  | { kind: "empty"; status: number }
  /** Statinis failas iš dist katalogo; kelio saugumą tikrina `resolveStaticPath`. */
  | { kind: "static"; urlPath: string }
  /** SSE prisijungimas — srautą perima adapteris. */
  | { kind: "sse" };

/** Vieno politikos pasiūlymo įvestis; laukus VALIDUOJA maršrutas, o ne adapteris. */
export type PolicyProposalInput = {
  setting_id: string;
  requested_value: unknown;
  reason: string;
};

/**
 * Sprendimo verbas HTTP kontrakte. Sąrašas pakartotas čia, o ne importuotas iš application
 * `PolicyDecisionVerb`, sąmoningai: portas yra KLIENTO kontraktas, tad naujas application verbas
 * neturi savaime atsirasti maršrute — jis atveriamas atskiru sprendimu (`cancel`, 2026-08-29).
 */
export type UiPolicyDecisionVerb = "approve" | "reject" | "apply" | "cancel";

/** Sprendimo įvestis. `actor` čia NĖRA sąmoningai: jį nustato serveris (žr. `decidePolicyChange`). */
export type PolicyDecisionRequest = {
  policy_file: string;
  setting_id: string;
  reason: string;
};

/**
 * Bundle mtime pora tiesiai iš fs, dar be interpretacijos. `null` reiškia „bundle nesukurtas" —
 * fs adapteris (atskira užduotis) taip atsako, kai `ui-app/dist/index.html` nerastas.
 */
export type BundleMtimeFacts = { bundleMtimeMs: number; srcMtimeMs: number } | null;

/**
 * `/api/dashboard` bundle senumo laukai iš žalių mtime faktų. Grynas skaičiavimas — jokio I/O —
 * kad testai galėtų pin'inti ribą (`srcMtimeMs > bundleMtimeMs`) be adapterio.
 */
export function bundleStalenessFields(facts: BundleMtimeFacts): {
  bundle_built_at: string | null;
  bundle_stale: boolean;
} {
  if (facts === null) return { bundle_built_at: null, bundle_stale: false };
  return {
    bundle_built_at: new Date(facts.bundleMtimeMs).toISOString(),
    bundle_stale: facts.srcMtimeMs > facts.bundleMtimeMs,
  };
}

export type UiRouterPorts = {
  dashboardData(uiToken: string): Promise<unknown>;
  /**
   * Bundle senumo faktai (`ui-app/dist` vs naujausias `ui-app/src` failas). Optional: tikras fs
   * adapteris sujungiamas atskiroje (composition) užduotyje — iki tol lauko tiesiog nėra, ir
   * `/api/dashboard` atsako `null` / `false`, be klaidos.
   */
  bundle?: { readFacts(): Promise<BundleMtimeFacts> };
  /** Visi pasiūlymai su sprendimų istorija: `{ proposals }`, o ne žalias žurnalo sąrašas. */
  listPolicyProposals(): Promise<unknown>;
  /**
   * Sukuria pasiūlymą grupei. Dabartinę reikšmę ir `routing` nustato SERVERIS — klientas jų
   * paduoti negali, nes suklastotas `routing: "queue"` apeitų human-review vartus prie `apply`.
   */
  proposePolicyChange(group: PolicyProposalGroup, input: PolicyProposalInput): Promise<unknown>;
  decidePolicyProposal(verb: UiPolicyDecisionVerb, input: PolicyDecisionRequest): Promise<unknown>;
  tokenUsage(query: URLSearchParams): Promise<unknown>;
  /**
   * Vieno žurnalo uodega (`?log=claude|orchestrator|checks&lines=N`).
   *
   * NAUJAS maršrutas (2026-08-24, operatoriaus sprendimas): etalonas jo neaptarnavo, nors
   * `AG/mobile-gateway` adapteris jo prašė — žr. `application/analytics/ui-log-query.ts`.
   * Grąžina `undefined` NEŽINOMAM žurnalo vardui, kad maršrutas galėtų atsakyti 400, o ne
   * tyliai atiduoti numatytąjį žurnalą.
   *
   * Tipas yra `Promise<unknown>`, o ne `Promise<unknown | undefined>`: `unknown` jau apima
   * `undefined`, tad sąjunga skaitytojui nieko nepasakytų, o lint'as ją teisingai vadina
   * perteklinę. Sutartis dėl `undefined` gyvena šiame komentare ir maršruto patikroje, ir ją
   * prikala `ui-log-query` testai.
   */
  logs(query: URLSearchParams): Promise<unknown>;
  tokenAnalytics(): Promise<unknown>;
  /** `fresh` apeina 10 s kešą — tai operatoriaus „Atnaujinti" mygtuko prasmė. */
  reliabilityAnalytics(fresh: boolean): Promise<unknown>;
  benchmarkReport(): Promise<unknown>;
  /** Kompresijos vėliavos + jų shadow telemetrija (`ui-compression-view`). */
  compressionView(): Promise<unknown>;
  /**
   * Vienos vėliavos perjungimas. META `InvalidCompressionRequestError` nežinomam raktui ar
   * neleistinai reikšmei — maršrutas tai verčia į 400 su domeno paaiškinimu, ne į 500.
   */
  setCompressionFeature(feature: string, value: unknown): Promise<unknown>;
  workflowBuckets(): Promise<unknown>;
  /** Vieno bucket'o PILNAS sąrašas; nežinomas bucket'as META `UnknownTaskBucketError`. */
  workflowBucketTasks(bucket: string): Promise<unknown>;
  wavesView(eventLimit: number): Promise<unknown>;
  decideLearningRecommendation(id: string, decision: "approved" | "rejected"): Promise<unknown>;
  openTaskBucketFolder(bucket: string): Promise<boolean>;
  uploadQueueFiles(rawBody: string): Promise<string[]>;
  ensureLoopRunning(): Promise<unknown>;
  requestLoopStop(): Promise<unknown>;
  /**
   * UI bundle rebuild paleidimas (`pnpm --dir ui-app build`, task 058-3). Optional TAIP PAT kaip
   * `bundle`: composition adapteris realiam spawn'ui sujungiamas atskiroje užduotyje, o iki tol
   * lauko tiesiog nėra, ir `/api/ui/rebuild` atsako `disabled`, ne 500.
   */
  uiRebuild?: { start(): Promise<unknown> };
  /** VISI slot'ai į `drain` po „Stop": kitaip valdiklis rodytų `run`, o vėliava jau įrašyta. */
  drainAllSlots(): Promise<unknown>;
  /** Valdiklio atstatymas prieš startą: likusi `drain` vėliava priverstų ką tik paleistą loop'ą atsisakyti pirmo task'o. */
  resetLoopControl(): Promise<unknown>;
  setRequestedWorkers(body: unknown): Promise<unknown>;
  setSlotMode(workerId: string, body: unknown): Promise<unknown>;
  applyTaskTriage(action: TaskTriageAction, reference: string): Promise<unknown>;
  /** Ar React dist katalogas rastas — be jo statiniai maršrutai neegzistuoja. */
  hasStaticAssets(): boolean;
  /** Klaidos žurnalui; klientui detalės niekada neišeina. */
  logError(message: string): void;
};

export type UiRouterDeps = {
  ports: UiRouterPorts;
  projectRoot: string;
  /** Per-server-start paslaptis. */
  uiToken: string;
  eventLimitFromQuery(query: URLSearchParams): number;
  platform?: NodeJS.Platform;
};

export const json = (data: unknown, status = 200): UiRouteResponse => ({ kind: "json", status, data });

export function toResponse(error: HttpErrorResponse): UiRouteResponse {
  return error.body
    ? { kind: "json", status: error.status, data: error.body }
    : { kind: "text", status: error.status, text: error.text ?? "" };
}

/** Koduotas segmentas; netinkamas kodavimas grąžina žalią reikšmę, o ne meta. */
export function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Privaloma neptuščia teksto reikšmė iš kūno. Grąžina `undefined`, kai laukas netinkamas —
 * kvietėjas tai verčia 400: netinkamas kūnas yra VARTOTOJO klaida, niekada ne 500.
 */
export function requiredText(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
