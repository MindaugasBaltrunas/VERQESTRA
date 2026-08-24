// Kanoninis dispatch modelio maršrutizatorius (etalono task 1109; WBR VQ-305).
//
// Visos taisyklės — VIENOJE grynoje, deterministinėje funkcijoje (`routeModel`), kuri
// operuoja provider-neutraliomis pakopomis (`domain/tokens/routing-tier.ts`). Provider
// vardai atsiranda tik adapteryje (E4), o IO — tik `loadRoutingPolicy` failsafe krautuve
// (konfigo skaitymas per PolicyConfigFileSystemPort).
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonStringify } from "../../shared/json.js";
import { findSectionBounds } from "../../shared/markdown.js";
import {
  AUTO_ESCALATION_CEILING,
  ROUTING_TIERS,
  clampRoutingTier,
  escalateRoutingTier,
  highestRoutingTier,
  routingTierRank,
  type RoutingTier,
} from "../../domain/tokens/routing-tier.js";
import { modelPolicyRoutingSection } from "../../domain/policies/model-policy-rules.js";
import { loadModelPolicy } from "../policy-governance/model-policy.js";
import type { PolicyConfigFileSystemPort } from "../policy-governance/ports.js";

export { AUTO_ESCALATION_CEILING, ROUTING_TIERS };
export type { RoutingTier };

/** Dispatch'inamos sesijos fazė. Atitinka `TaskPhase` porūšį, kurį naudoja dispatch. */
export type RoutingPhase = "implementation" | "repair";

/**
 * Maršrutizatoriaus TAISYKLIŲ versija (ne konfigo). Įeina į `policy_hash`, todėl pakeitus
 * pačias taisykles telemetrijoje matosi, kad sprendimai nebepalyginami su ankstesniais net
 * jei konfigas nepasikeitė.
 */
export const ROUTER_RULES_VERSION = 1;

/**
 * `model-policy.json` → `routing` blokas. Visi laukai turi numatytąsias reikšmes, todėl
 * trūkstamas blokas yra pilnai galiojanti politika.
 *
 * `.prefault({})` (ne `.default({})`) sąmoningai: zod 4 `.default()` nebeparsina numatytosios
 * reikšmės, o grąžina ją tiesiai — `{}` tada nueitų pro vidinius `on_retry`/`max_tier`
 * defaultus ir eskalacija tyliai išsijungtų. `.prefault()` numatytąją reikšmę praleidžia per
 * schemą, tad vidiniai defaultai suveikia.
 */
export const routingPolicySchema = z
  .object({
    version: z.number().int().positive().default(1),
    escalation: z
      .object({
        on_retry: z.boolean().default(true),
        max_tier: z.enum(ROUTING_TIERS).default(AUTO_ESCALATION_CEILING),
        /**
         * Kiek pirmųjų nesėkmių sugeriama NEKELIANT pakopos.
         *
         * Etalono 2026-08-06 tokenų auditas: iš 9 užduočių su lygiai vienu repair priimta
         * buvo 1 (11 %), o vienas repair dispatch kainuoja 1,9–3,3 mln. tokenų. Pirmoji
         * nesėkmė paprastai yra mechaninė — tą patį modelį pakanka paleisti dar kartą JAU
         * MATANT klaidą. Eskalacija prasminga tada, kai modelis, matydamas klaidą, jos vis
         * tiek neištaisė. `0` grąžina senąjį elgesį (eskaluoti nuo pirmos nesėkmės).
         */
        defer_steps: z.number().int().min(0).max(3).default(1),
      })
      .prefault({}),
    /**
     * Minimali pakopa konkrečiai fazei. Shipped konfige SĄMONINGAI nėra — grindys repair
     * fazei pabrangintų kiekvieną taisymą; schema jas palaiko operatoriui.
     */
    phase_floor: z.record(z.string(), z.enum(ROUTING_TIERS)).optional(),
    freeze_escalation_under_budget_pressure: z.boolean().default(true),
  })
  .passthrough();

export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

/** Politika, galiojanti be jokio konfigo (ir kiekvienam failsafe atvejui). */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = routingPolicySchema.parse({});

/**
 * Kodėl sprendimas toks, koks yra. Kodai kaupiami ta pačia tvarka, kuria taikomos
 * taisyklės, todėl `reason` eilutė yra atsekamas sprendimo pėdsakas log'e.
 */
export type RoutingReasonCode =
  | "explicit-selection"
  | "risk-signals"
  | "source-change"
  | "routine-default"
  | "structural-size"
  | "phase-floor"
  | "retry-escalation"
  | "escalation-ceiling"
  | "explicit-above-ceiling"
  | "budget-freeze"
  | "escalation-disabled"
  /** Nesėkmė buvo, bet pakopa nekelta: ją sugėrė `escalation.defer_steps`. */
  | "escalation-deferred"
  | "policy-default";

/** Biudžeto signalai iš `authorizeLlmCall` (jau apskaičiuoti — čia jokio IO). */
export type RoutingBudgetSignals = {
  reduceContext: boolean;
  remainingTotalLlmCalls: number | null;
  remainingTotalTokens: number | null;
  totalLlmCalls: number;
};

/** Struktūrinis užduoties dydis iš `measureTaskSize`. */
export type RoutingTaskSize = {
  lines: number;
  allowedPaths: number;
  domains: number;
  actionBullets: number;
};

export type RouteModelInput = {
  phase: RoutingPhase;
  taskText: string;
  /** Supervisor/žmogaus EXPLICIT parinkimas; nenurodžius sprendžia turinys. */
  selectedTier?: RoutingTier;
  failedAttempts: number;
  size: RoutingTaskSize;
  budget?: RoutingBudgetSignals;
  policy?: RoutingPolicy;
};

export type RouteModelDecision = {
  tier: RoutingTier;
  base_tier: RoutingTier;
  ceiling: RoutingTier;
  escalation_steps: number;
  reason: string;
  reason_codes: RoutingReasonCode[];
  policy_hash: string;
};

// Aukštos rizikos / sudėtingumo signalai: architektūra, DB/migracijos, security,
// auth/approval, public API, refactor, cross-platform — šie sprendimai verti aukštesnės
// pakopos. TOK-02: bare `schema` susiaurintas iki DB konteksto; godus `auth\w*` susiaurintas
// iki pilnų auth žodžių (jis matchino failų vardus ir versdavo UI task'us aukštyn).
const HIGH_COMPLEXITY_PATTERN =
  /\b(migrac\w*|migration|(?:db|database)\s+schem\w*|schema\.prisma|postgis|sql|security|saugum\w*|auth|authn|authz|authentication|authorization|autentifikacij\w*|autorizacij\w*|rbac|approv\w*|public api|public kontrakt\w*|architekt\w*|architect|refactor\w*|cross-?platform|breaking|critical|kritin\w*)\b/i;

// Source kodo keitimo signalai: ribota, bet netriviali implementacija.
const SOURCE_CHANGE_PATTERN =
  /\b(?:apps|modules|packages|workers|AG\/orchestrator|AG\\orchestrator)\/|\bmodule\.manifest\.ts\b|\bsrc\//i;

// TOK-02: `## Agentai` sekcija yra maršrutavimo METADATA, ne rizikos turinys — grandinė
// `architect -> coder -> reviewer` versdavo kiekvieną task'ą į aukščiausią pakopą vien dėl
// agento VARDO. Prieš klasifikavimą sekcija išmetama.
function stripAgentaiSection(text: string): string {
  const lines = text.split(/\r?\n/);
  // Riba — `shared/markdown.findSectionBounds` (2026-08-24, RAG auditas 5). Fence-aklas ciklas
  // išmesdavo per mažai, tad agentų vardai vėl patekdavo į rizikos klasifikaciją — būtent tai,
  // nuo ko TOK-02 juos ir atskyrė.
  const bounds = findSectionBounds(lines, (line) => /^##\s*Agentai\b/.test(line.trim()));
  return bounds === undefined ? text : [...lines.slice(0, bounds.start), ...lines.slice(bounds.end)].join("\n");
}

/**
 * Rizikos pakopa iš užduoties TURINIO: `advanced` aukštos rizikos darbams, `standard`
 * source kodo keitimui, `routine` paprastoms užduotims. Klaidingai žema pakopa nėra
 * pavojinga: retry eskalacija nesėkmę pakelia laipteliu aukščiau.
 */
export function classifyTaskRiskTier(taskText: string): { tier: RoutingTier; code: RoutingReasonCode } {
  const text = stripAgentaiSection(taskText ?? "");
  if (HIGH_COMPLEXITY_PATTERN.test(text)) {
    return { tier: "advanced", code: "risk-signals" };
  }
  if (SOURCE_CHANGE_PATTERN.test(text)) {
    return { tier: "standard", code: "source-change" };
  }
  return { tier: "routine", code: "routine-default" };
}

/**
 * Politikos + taisyklių versijos atspaudas telemetrijai: du sprendimai palyginami tik tada,
 * kai sutampa ir konfigas, ir taisyklių versija.
 */
export function routingPolicyHash(policy: RoutingPolicy): string {
  const digest = createHash("sha256")
    .update(canonicalJsonStringify({ rules: ROUTER_RULES_VERSION, policy }), "utf8")
    .digest("hex");
  return `rt${ROUTER_RULES_VERSION}:${digest.slice(0, 16)}`;
}

/**
 * VIENINTELĖ vieta, kur gimsta dispatch modelio pakopa. Gryna ir deterministinė: jokio IO,
 * jokio laiko, jokio provider'io vardo — tie patys įėjimai visada duoda tą patį sprendimą,
 * todėl jį galima atkurti iš log'o eilutės.
 *
 * SĄMONINGAI NEDAROMA: infrastruktūrinių (`zero_usage`) bandymų atėmimas iš
 * `failedAttempts`. Retry skaitiklis jų jau neskaičiuoja — atėmimas čia būtų dvigubas ir
 * nuleistų pakopą po realių nesėkmių.
 */
export function routeModel(input: RouteModelInput): RouteModelDecision {
  const policy = input.policy ?? DEFAULT_ROUTING_POLICY;
  const reasonCodes: RoutingReasonCode[] = [];

  // 1. Bazė: explicit parinkimas nugali turinio klasifikaciją.
  let base: RoutingTier;
  if (input.selectedTier) {
    base = input.selectedTier;
    reasonCodes.push("explicit-selection");
  } else {
    const risk = classifyTaskRiskTier(input.taskText);
    base = risk.tier;
    reasonCodes.push(risk.code);
  }

  // 2. Fazės grindys (jei operatorius jas sukonfigūravo) — tik kelia, niekada neleidžia.
  const floor = policy.phase_floor?.[input.phase];
  if (floor) {
    base = highestRoutingTier([base, floor]);
    reasonCodes.push("phase-floor");
  }

  // 3. Struktūrinis dydis. Didelis scope pats savaime NĖRA rizika, todėl niekada nekelia
  // aukščiau `standard` — tai apsauga nuo daugiafailių užduočių, kurias žemiausia pakopa
  // apdoroja pusiau.
  const sizeTier: RoutingTier =
    input.size.allowedPaths > 2 || input.size.actionBullets > 2 || input.size.domains > 1 || input.size.lines > 100
      ? "standard"
      : "routine";
  const withSize = highestRoutingTier([base, sizeTier]);
  if (withSize !== base) {
    base = withSize;
    reasonCodes.push("structural-size");
  }

  // 4. Lubos. Konfigas gali TIK sugriežtinti: `clampRoutingTier` neleidžia jokiai konfigo
  // reikšmei pakelti automatinių lubų virš `AUTO_ESCALATION_CEILING`, todėl aukščiausia
  // pakopa per konfigą nepasiekiama (etalono 2026-07-22 invariantas).
  const ceiling = clampRoutingTier(policy.escalation.max_tier, AUTO_ESCALATION_CEILING);
  // Explicit parinkimas virš lubų išlaikomas, bet eskalacija jo nedidina.
  let effectiveCeiling = ceiling;
  if (routingTierRank(base) > routingTierRank(ceiling)) {
    effectiveCeiling = base;
    reasonCodes.push("explicit-above-ceiling");
  }

  // 5. Eskalacijos žingsniai + biudžeto stop-kranas.
  let steps = 0;
  if (policy.escalation.on_retry) {
    // Pirmosios `defer_steps` nesėkmės sugeriamos nekeliant pakopos: pakartotinis bandymas
    // TUO PAČIU modeliu, jau matant klaidą, yra pigiausias taisymas, o brangesnė pakopa
    // pagrįsta tik tada, kai jis nepadėjo.
    const failed = Math.max(0, Math.floor(input.failedAttempts));
    steps = Math.max(0, failed - policy.escalation.defer_steps);
    if (failed > 0 && steps === 0) {
      reasonCodes.push("escalation-deferred");
    }
  } else {
    reasonCodes.push("escalation-disabled");
  }
  const budget = input.budget;
  if (
    policy.freeze_escalation_under_budget_pressure &&
    budget &&
    (budget.reduceContext || budget.remainingTotalTokens === 0 || budget.remainingTotalLlmCalls === 0)
  ) {
    // Išsemiamas biudžetas yra bloga vieta brangesniam modeliui: eskalacija čia pagreitintų
    // būtent tą degimą, kurį biudžetas bando stabdyti.
    steps = 0;
    reasonCodes.push("budget-freeze");
  }

  // 6. Galutinė pakopa.
  const tier = escalateRoutingTier(base, steps, effectiveCeiling);
  if (routingTierRank(tier) > routingTierRank(base)) {
    reasonCodes.push("retry-escalation");
  }
  if (routingTierRank(base) + steps > routingTierRank(effectiveCeiling)) {
    reasonCodes.push("escalation-ceiling");
  }

  // 7. Atsekamumas.
  if (reasonCodes.length === 0) {
    reasonCodes.push("policy-default");
  }
  return {
    tier,
    base_tier: base,
    ceiling,
    escalation_steps: steps,
    reason: `${reasonCodes.join(",")} base=${base} steps=${steps} ceiling=${ceiling} tier=${tier}`,
    reason_codes: reasonCodes,
    policy_hash: routingPolicyHash(policy),
  };
}

/**
 * FAILSAFE krautuvas: trūkstamas failas, blogas JSON arba blogas `routing` blokas grąžina
 * {@link DEFAULT_ROUTING_POLICY} ir NIEKADA nemeta. Precedentas — tool-budget failsafe:
 * sugadintas politikos konfigas neturi užrakinti dispatch'o, nes tada visas loop'as sustotų
 * dėl neveikiančio nebūtino nustatymo.
 */
export async function loadRoutingPolicy(fs: PolicyConfigFileSystemPort, runtimeRoot: string): Promise<RoutingPolicy> {
  try {
    const section = modelPolicyRoutingSection(await loadModelPolicy(fs, runtimeRoot));
    if (section === undefined) {
      return DEFAULT_ROUTING_POLICY;
    }
    return routingPolicySchema.parse(section);
  } catch {
    return DEFAULT_ROUTING_POLICY;
  }
}
