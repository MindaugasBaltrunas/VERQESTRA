// Rizika pagrįsta semantinė integracijos peržiūra (spec IVER-3, design §11). Behaviour
// etalon: AG_loop application/integration/review-integration.ts (1:1).
//
// `evaluate-integration-risk.ts` pasako, AR peržiūros reikia. Šis modulis yra vienintelė
// vieta, kur ji realiai vyksta — ir vienintelė vieta, iš kurios integracijos kelyje
// apskritai gali būti išleistas LLM kvietimas.
//
// KETURI kontraktai, kurie čia yra taisyklė: (1) LLM kviečiamas TIK esant
// `review-required` — `routine` grąžina `no-review` nekvietęs, `human-review` irgi
// nekviečia; (2) sąnaudos apskaitomos tai pačiai task fazei — kvietimas pirma
// autorizuojamas, po to usage įrašoma; (3) prompt'as ribojamas rizikos apimtimi — jokio
// failų turinio, viso diff'o ar log uodegų; (4) neaiškumas niekada nevirsta patvirtinimu —
// nesantis reviewer'is, išsemtas biudžetas, kvietimo klaida ar neišanalizuojamas
// atsakymas duoda `human-review`, o ne `approved`.
//
// Modulis neturi FS, proceso ar tinklo priklausomybių — realų modelio kvietimą, biudžeto
// vartus ir usage žurnalą paduoda kvietėjas per `IntegrationReviewDeps` (E4/E5).

import { createHash } from "node:crypto";
import type { ContractDiffEntry, ContractDiffReport } from "./contract-model.js";
import type { WaveGateReport } from "./wave-gates-schema.js";
import type { IntegrationConflict, IntegrationRiskVerdict } from "./evaluate-integration-risk.js";

/** Kanoninė fazė, kuriai priskiriamas kiekvienas šio kelio LLM kvietimas. */
export const INTEGRATION_REVIEW_PHASE = "integration-review";

/** Kiek `focus` kontraktų telpa į prompt'ą. Nutrauktas likutis VISADA paskelbiamas prompt'e. */
export const MAX_PROMPT_CONTRACTS = 12;

/** Kiek konfliktų telpa į prompt'ą. Ta pati „jokių tylių apkarpymų" taisyklė. */
export const MAX_PROMPT_CONFLICTS = 8;

export type IntegrationReviewerVerdict = "approve" | "changes-required" | "escalate";

export type IntegrationReviewFinding = {
  /** Konflikto arba kontrakto id, su kuriuo išvada susijusi. */
  target: string;
  detail: string;
  paths: string[];
};

export type IntegrationReviewUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number;
};

export type IntegrationReviewerResponse = {
  verdict: IntegrationReviewerVerdict;
  summary: string;
  findings: IntegrationReviewFinding[];
  /** Reviewer'io siūlomos alternatyvos, kai jis eskaluoja. */
  alternatives?: string[];
  model?: string;
  usage?: IntegrationReviewUsage;
};

export type IntegrationReviewerRequest = {
  taskId: string;
  waveId: string;
  prompt: string;
  risk: IntegrationRiskVerdict;
};

/** Semantinis reviewer'is. Realų modelio kvietimą įgyvendina E4/E5 pusė. */
export type IntegrationReviewerPort = {
  review(request: IntegrationReviewerRequest): Promise<IntegrationReviewerResponse>;
};

export type IntegrationReviewAuthorization = { allowed: boolean; reasons: string[] };

/** `integration-review` fazės biudžeto vartai PRIEŠ kvietimą (token-governance). */
export type IntegrationReviewBudgetPort = {
  authorize(request: { taskId: string; phase: typeof INTEGRATION_REVIEW_PHASE }): Promise<IntegrationReviewAuthorization>;
};

/** Usage apskaita PO kvietimo. Best-effort: telemetrijos klaida peržiūros verdikto nekeičia. */
export type IntegrationReviewUsagePort = {
  record(entry: {
    taskId: string;
    phase: typeof INTEGRATION_REVIEW_PHASE;
    model: string;
    usage?: IntegrationReviewUsage;
    outcome: "succeeded" | "failed";
  }): Promise<void>;
};

export type IntegrationReviewDeps = {
  reviewer?: IntegrationReviewerPort;
  budget?: IntegrationReviewBudgetPort;
  usage?: IntegrationReviewUsagePort;
};

export type IntegrationReviewScope = {
  taskId: string;
  waveId: string;
  /** Task'o priėmimo kriterijai — reviewer'io klausimo riba, ne bendras kodo stilius. */
  acceptanceCriteria?: readonly string[];
  contractDiff: ContractDiffReport;
  gates?: WaveGateReport;
  conflicts?: readonly IntegrationConflict[];
  /** Tiesiogiai paliesti moduliai. Netiesioginiai vartotojai į prompt'ą nepatenka. */
  modules?: readonly string[];
};

export type ReviewIntegrationInput = {
  risk: IntegrationRiskVerdict;
  scope: IntegrationReviewScope;
  deps?: IntegrationReviewDeps;
  /** Modelio identifikatorius apskaitai; kvietimo maršruto jis nekeičia. */
  model?: string;
};

export type IntegrationReviewStatus = "no-review" | "approved" | "repair-required" | "human-review";

export type IntegrationReviewOutcome = {
  status: IntegrationReviewStatus;
  /** Ar realiai buvo išleistas semantinis kvietimas. Tai ir yra auditinis IVER-3 faktas. */
  llm_invoked: boolean;
  reason: string;
  findings: IntegrationReviewFinding[];
  /** Konkrečios alternatyvos žmogui; tuščios visais ne-`human-review` atvejais. */
  alternatives: string[];
  risk: IntegrationRiskVerdict;
  /** Faktinis reviewer'iui nusiųstas prompt'as — tik kai kvietimas įvyko. */
  prompt?: string;
  /** Prompt'o atspaudas: leidžia įrodyti, kad peržiūrėta būtent ši apimtis. */
  prompt_hash?: string;
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function bullet(lines: readonly string[]): string {
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- (nėra)";
}

function describeContract(entry: ContractDiffEntry): string {
  const before = entry.before?.signature ?? "(nebuvo)";
  const after = entry.after?.signature ?? "(nebėra)";
  return `${entry.id} [${entry.change}/${entry.breaking_risk}]: "${before}" -> "${after}" (${entry.reasons.join("; ")})`;
}

/**
 * Reviewer'io prompt'as. Apimtis = rizikos `focus`, ir nieko daugiau.
 *
 * Apkarpymai (`MAX_PROMPT_*`) yra AIŠKŪS: nutrauktas likutis paskelbiamas pačiame
 * prompt'e, kad modelis nespręstų remdamasis tyliai nukirpta apimtimi.
 */
export function buildIntegrationReviewPrompt(risk: IntegrationRiskVerdict, scope: IntegrationReviewScope): string {
  const focusContracts = new Set(risk.focus.contracts);
  const entries = scope.contractDiff.entries.filter((entry) => focusContracts.has(entry.id));
  const shownEntries = entries.slice(0, MAX_PROMPT_CONTRACTS);
  const droppedEntries = entries.length - shownEntries.length;

  const conflicts = (scope.conflicts ?? []).filter((conflict) => risk.focus.conflicts.includes(conflict.id));
  const shownConflicts = conflicts.slice(0, MAX_PROMPT_CONFLICTS);
  const droppedConflicts = conflicts.length - shownConflicts.length;

  const gateLines = risk.focus.failing_gates.map((gate) => {
    const result = scope.gates?.gates.find((candidate) => candidate.gate === gate);
    return `${gate}: ${result?.status ?? "unknown"}${result?.detail ? ` — ${result.detail}` : ""}`;
  });

  return `# Integration semantic review

Tu esi integracijos vartų reviewer'is. Atsakai TIK į vieną klausimą: ar žemiau išvardyti
kontraktų pokyčiai ir konfliktai gali būti sulieti į pagrindinę šaką nesugriaunant jų
vartotojų. Bendro kodo stiliaus, formatavimo ar architektūros preferencijų NEVERTINK.

## Task
${scope.taskId} (wave ${scope.waveId})

## Risk verdict
${risk.level} (${risk.verdict_hash})
${bullet(risk.reasons)}

## Acceptance criteria
${bullet([...(scope.acceptanceCriteria ?? [])])}

## Changed public contracts
${bullet(shownEntries.map(describeContract))}${droppedEntries > 0 ? `\n- (+${droppedEntries} daugiau kontraktų neparodyta — apimtis apkarpyta ties ${MAX_PROMPT_CONTRACTS})` : ""}

## Failing gates
${bullet(gateLines)}

## Conflicts
${bullet(
  shownConflicts.map(
    (conflict) =>
      `${conflict.id}: ${conflict.summary?.trim() || "konfliktas"} [${conflict.paths.join(", ")}]${
        conflict.tasks?.length ? ` tarp ${conflict.tasks.join(", ")}` : ""
      }`,
  ),
)}${droppedConflicts > 0 ? `\n- (+${droppedConflicts} daugiau konfliktų neparodyta — apimtis apkarpyta ties ${MAX_PROMPT_CONFLICTS})` : ""}

## Direct modules
${bullet([...(scope.modules ?? risk.focus.modules)])}

## Atsakymas
Grąžink TIK JSON objektą:
{
  "verdict": "approve" | "changes-required" | "escalate",
  "summary": "<max 400 simbolių>",
  "findings": [{ "target": "<kontrakto ar konflikto id>", "detail": "<kas lūžta>", "paths": ["<kelias>"] }],
  "alternatives": ["<konkretus veiksmas, kai verdict=escalate>"]
}
- \`approve\` tik tada, kai kiekvienas aukščiau esantis pokytis yra suderinamas su savo vartotojais.
- \`changes-required\`, kai lūžį galima pataisyti šio konflikto apimtyje.
- \`escalate\`, kai sprendimui reikia žmogaus (produkto sprendimas, plati migracija, neaiški apimtis).
`;
}

export function computeIntegrationPromptHash(prompt: string): string {
  return `ip1:${createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Atsakymo normalizavimas
// ---------------------------------------------------------------------------

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter(Boolean) : [];
}

function parseFindings(value: unknown): IntegrationReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: IntegrationReviewFinding[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const detail = asString(record["detail"]);
    if (!detail) continue;
    findings.push({ target: asString(record["target"]), detail, paths: asStringList(record["paths"]) });
  }
  return findings;
}

/**
 * Neapdorotą reviewer'io atsakymą paverčia verdiktu.
 *
 * Neatpažintas verdiktas ar neišanalizuojamas atsakymas virsta `escalate`, o ne
 * `approve`: peržiūros REZULTATO NEBUVIMAS negali reikšti leidimo (ta pati taisyklė,
 * kaip `contract-diff.ts` `unverified` įrašuose).
 */
export function parseIntegrationReviewResponse(raw: unknown): IntegrationReviewerResponse {
  let value = raw;
  if (typeof value === "string") {
    const text = value.trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return { verdict: "escalate", summary: "reviewer response is not JSON", findings: [] };
    }
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { verdict: "escalate", summary: "reviewer response is not valid JSON", findings: [] };
    }
  }
  if (value === null || typeof value !== "object") {
    return { verdict: "escalate", summary: "reviewer response is not an object", findings: [] };
  }

  const record = value as Record<string, unknown>;
  const verdict = asString(record["verdict"]);
  const known: IntegrationReviewerVerdict[] = ["approve", "changes-required", "escalate"];
  const normalized = known.find((candidate) => candidate === verdict);
  const model = asString(record["model"]);
  return {
    verdict: normalized ?? "escalate",
    summary: asString(record["summary"]) || (normalized ? "" : `unknown reviewer verdict: ${verdict || "(none)"}`),
    findings: parseFindings(record["findings"]),
    alternatives: asStringList(record["alternatives"]),
    ...(model ? { model } : {}),
  };
}

// ---------------------------------------------------------------------------
// Alternatyvos
// ---------------------------------------------------------------------------

/**
 * Konkrečios alternatyvos žmogui. Sąrašas išvedamas iš signalų, todėl jis niekada nėra
 * bendras „peržiūrėk ranka" — kiekviena eilutė yra veiksmas, kurį galima atlikti.
 */
export function integrationAlternatives(risk: IntegrationRiskVerdict): string[] {
  const alternatives: string[] = [];
  const codes = new Set(risk.signals.map((signal) => signal.code));

  if (codes.has("destructive-migration") || codes.has("db-contract")) {
    alternatives.push(
      "Patvirtink DB pokytį atskirai: išskirk migraciją į savo task'ą su aiškiu žmogaus patvirtinimu ir integruok ją prieš likusią bangą.",
    );
  }
  if (codes.has("security-contract")) {
    alternatives.push(
      "Auth/permission kontraktą peržiūrėk `security` grandine ir integruok jį atskira banga, kad jo rizika nesimaišytų su likusiais pokyčiais.",
    );
  }
  if (codes.has("repeated-conflict")) {
    alternatives.push(
      "Pašalink konfliktuojantį task'ą iš šios bangos ir suplanuok jį kitai bangai ant jau integruoto base'o.",
    );
    alternatives.push(
      "Sulieti konfliktuojančius pokyčius į vieną task'ą, kad tas pats kontraktas nebūtų keičiamas dviejose vietose lygiagrečiai.",
    );
  }
  if (codes.has("contract-break") || codes.has("multi-module-contract")) {
    alternatives.push(
      "Priimk breaking kontrakto pokytį sąmoningai: atnaujink visus vartotojus viename task'e arba palik suderinamumo sluoksnį ir suplanuok pašalinimą atskirai.",
    );
  }
  if (codes.has("contract-unverified")) {
    alternatives.push(
      "Pateik trūkstamą kontrakto turinį (abi revizijos) ir perleisk contract diff — `unverified` be turinio negali tapti „suderinama“.",
    );
  }
  if (alternatives.length === 0) {
    alternatives.push("Peržiūrėk bangą rankiniu būdu ir arba patvirtink integraciją, arba grąžink task'ą į queue.");
  }
  return alternatives;
}

// ---------------------------------------------------------------------------
// Peržiūra
// ---------------------------------------------------------------------------

function outcome(
  status: IntegrationReviewStatus,
  risk: IntegrationRiskVerdict,
  reason: string,
  extra: Partial<IntegrationReviewOutcome> = {},
): IntegrationReviewOutcome {
  return {
    status,
    llm_invoked: false,
    reason,
    findings: [],
    alternatives: status === "human-review" ? integrationAlternatives(risk) : [],
    risk,
    ...extra,
  };
}

/**
 * Rizika pagrįsta semantinė peržiūra.
 *
 * Grąžinamas VISADA — terminalinį perėjimą (human-review) taiko RunCoordinator, ne šis
 * modulis. `llm_invoked` yra kontraktinis laukas: pagal jį galima įrodyti, kad rutininis
 * pakeitimas modelio nekvietė.
 */
export async function reviewIntegration(input: ReviewIntegrationInput): Promise<IntegrationReviewOutcome> {
  const { risk, scope } = input;
  const deps = input.deps ?? {};

  if (risk.human_review_required) {
    return outcome(
      "human-review",
      risk,
      `integration risk is hard-gated (${risk.signals
        .filter((signal) => signal.level === "human-review")
        .map((signal) => signal.code)
        .join(", ")}) — automatic approval is not permitted`,
    );
  }

  if (!risk.semantic_review_allowed) {
    return outcome("no-review", risk, `semantic review not required: ${risk.reasons[0] ?? "routine change"}`);
  }

  if (!deps.reviewer) {
    return outcome("human-review", risk, "semantic reviewer is not available for a review-required integration risk");
  }

  if (deps.budget) {
    const authorization = await deps.budget.authorize({ taskId: scope.taskId, phase: INTEGRATION_REVIEW_PHASE });
    if (!authorization.allowed) {
      return outcome(
        "human-review",
        risk,
        `integration-review budget exhausted: ${authorization.reasons.join("; ") || "no remaining allowance"}`,
      );
    }
  }

  const prompt = buildIntegrationReviewPrompt(risk, scope);
  const promptHash = computeIntegrationPromptHash(prompt);
  const model = input.model ?? "sonnet";

  let response: IntegrationReviewerResponse;
  try {
    response = await deps.reviewer.review({ taskId: scope.taskId, waveId: scope.waveId, prompt, risk });
  } catch (error) {
    await recordUsage(deps, scope.taskId, model, undefined, "failed");
    return outcome("human-review", risk, `semantic reviewer failed: ${errorMessage(error)}`, {
      llm_invoked: true,
      prompt,
      prompt_hash: promptHash,
    });
  }

  await recordUsage(deps, scope.taskId, response.model ?? model, response.usage, "succeeded");

  const base = { llm_invoked: true, prompt, prompt_hash: promptHash } as const;
  if (response.verdict === "approve") {
    return outcome("approved", risk, response.summary || "semantic reviewer approved the integration", base);
  }
  if (response.verdict === "changes-required") {
    return outcome("repair-required", risk, response.summary || "semantic reviewer requires targeted changes", {
      ...base,
      findings: response.findings,
    });
  }
  return outcome("human-review", risk, response.summary || "semantic reviewer escalated the integration", {
    ...base,
    findings: response.findings,
    alternatives: [...(response.alternatives ?? []), ...integrationAlternatives(risk)],
  });
}

/** Telemetrija yra best-effort: jos klaida negali pakeisti peržiūros verdikto. */
async function recordUsage(
  deps: IntegrationReviewDeps,
  taskId: string,
  model: string,
  usage: IntegrationReviewUsage | undefined,
  result: "succeeded" | "failed",
): Promise<void> {
  if (!deps.usage) return;
  try {
    await deps.usage.record({ taskId, phase: INTEGRATION_REVIEW_PHASE, model, ...(usage ? { usage } : {}), outcome: result });
  } catch {
    // Apskaitos klaida lieka apskaitos problema.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
