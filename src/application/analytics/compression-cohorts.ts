// Canary vs control cohort palyginimas context-compression eksperimentui (etalono task 0004,
// WBR VQ-305). Canary markeris rašomas context-size žurnale (`canary_features`,
// context-pack/metrics), o TO PATIES task'o baigtis gyvena token-usage ir task-events
// žurnaluose — šis modulis yra tas `task_id` join'as, kurį skaito promotion sprendimas.
//
// Pure by construction: fold'ina jau perskaitytus įrašus ir grąžina raportą. Jokio IO —
// trys įrašų formos deklaruotos struktūriškai, tad kiekvienas kvietėjas paduoda tai, ką jo
// skaitytojas pagamino. Vienintelis importas — fallback markerio literalas, dalinamas su jį
// rašančiu moduliu, kad abi pusės niekada neišsiskirtų jo rašyba.

import {
  attributeCanaryOutcome,
  isArrestCountableAttribution,
  type AttributedCanaryOutcome,
} from "../context-pack/arrest-attribution.js";
import {
  findTokenizerUnfriendlySignals,
  median,
  type CohortPostRunRow,
  type TokenizerUnfriendlySignal,
} from "./tokenizer-unfriendly-signal.js";
import {
  joinAttemptScopedCohort,
  type ArmAssignment,
  type LegacyAttemptGroup,
  type TaskUsage,
} from "./attempt-identity-join.js";
import type {
  AppliedArm,
  AssignmentArm,
  CohortContextSizeRecord,
  CohortTokenUsageRecord,
} from "./cohort-model.js";

// API paritetas su etalonu: šie tipai istoriškai gyveno čia — re-eksportuojami iš
// cohort-model.ts (žr. jo antraštę apie type-only ciklo išardymą).
export type {
  AppliedArm,
  AssignmentArm,
  CohortContextSizeRecord,
  CohortTokenUsageRecord,
} from "./cohort-model.js";

/**
 * Minimalus task'ų kiekis, prieš kuriam esant arm'as apskritai raportuoja percentilį ar
 * rate: mediana per du task'us yra triukšmas su skaičiaus drabužiais.
 */
export const COHORT_MIN_SAMPLE = 5;

/** `CohortRow` numatytojo arm tipo alias'as — esami skaitytojai lieka assignment dimensijoje. */
export type CohortArm = AssignmentArm;

/**
 * Baigtį nešantis task-events įrašo poaibis. `phase`/`reason`/`exit_code` yra failure
 * SIGNATŪRA (0037) — trys laukai, kuriuos rašo pats žurnalas, todėl jais saugu klasifikuoti.
 * Optional, nes lifecycle įvykis be jų vis tiek yra lifecycle įvykis — tik neatributuojamas.
 */
export type CohortTaskEvent = {
  ts?: string;
  task_id: string;
  to_state?: string;
  phase?: string;
  reason?: string;
  exit_code?: number;
};

/**
 * Ant kiek task'ų kiekviena metrika REALIAI išmatuota. Jie NĖRA lygūs `n`: task'as gali būti
 * arm'e ir neturėti usage apskaitos, turn skaičiaus ar lifecycle įvykio. Mediana per tris
 * išmatuotus task'us po antrašte `n=40` būtų ta pati fabrikuota precizija, nuo kurios saugo
 * {@link COHORT_MIN_SAMPLE} — tad kiekviena metrika nešasi savo vardiklį.
 */
export type CohortSampleSizes = {
  billable: number;
  turns: number;
  humanReview: number;
  repair: number;
};

export type CohortRow<Arm extends string = CohortArm> = {
  arm: Arm;
  /** Skirtingi task'ai arm'e — po kartą per task'ą, niekada per bandymą. */
  n: number;
  /** Tiems task'ams surinkti context pack'ai — t. y. dispatch'ai, įsk. re-dispatch'us. */
  dispatchCount: number;
  /** `n < COHORT_MIN_SAMPLE`: arm'as egzistuoja, bet dar nieko nesako. */
  insufficientSample: boolean;
  /** Mediana billable tokenų per task'ą (input + output + cache creation, be cache read). */
  billableTokensP50?: number;
  /** Mediana `num_turns` per task'ą, sumuota per jo dispatch'us. */
  turnsP50?: number;
  /** Dalis išmatuojamų task'ų, kurių vėliausias lifecycle įvykis — `human-review`. */
  humanReviewRate?: number;
  /** Dalis išmatuojamų task'ų su bent vienu repair/retry dispatch'u. */
  repairRate?: number;
  samples: CohortSampleSizes;
};

/**
 * Trys canary human-review baigties perskaitymai (0037) — atskiri skaičiai, niekada suma:
 * tik `arrestCounted` yra įrodymas apie kompresiją, `warningOnly` — reali žmogaus kaina su
 * nustatyta ne-kompresijos priežastimi, `unattributed` — duomenys, kurių taisyklių lentelė
 * neperskaitė.
 */
export type HumanReviewAttributionBucket = {
  /** `compression-suspected` arba `compression-proven` — vienintelės arrest'ą leidžiančios. */
  arrestCounted: number;
  /** `unrelated`: atpažinta ne-kompresijos signatūra. Warning statistika, ne kill signalas. */
  warningOnly: number;
  /** Atribucija neįmanoma — pre-0037 įrašas arba neatpažinta signatūra. */
  unattributed: number;
};

export type FeatureHumanReviewAttribution = HumanReviewAttributionBucket & {
  feature: string;
  /** Task'ai, realiai laikomi prieš šį feature — arrest'ą galima patikrinti ranka. */
  arrestCountedTaskIds: string[];
};

export type CompressionCohortAttributionReport = {
  /** Per skirtingą TASK'Ą, ne per feature: task'as po trimis features čia skaičiuoja kartą. */
  totals: HumanReviewAttributionBucket;
  /** Per feature — pjūvis, ant kurio realiai veikia kill switch. */
  byFeature: FeatureHumanReviewAttribution[];
  /**
   * Kodėl kiekviena neskaičiuota baigtis nebuvo skaičiuota — taisyklės vardu ir task'ų
   * kiekiu. `legacy-missing-attribution-fields` čia yra eksplicitinis pre-0037 įrašų
   * įvardijimas, ne tyla.
   */
  rules: Array<{ rule: string; n: number }>;
};

export type CompressionCohortReport = {
  generatedAt: string;
  /** Intention-to-treat: po eilutę ne-tuščiam {@link AssignmentArm}. Tuščias arm'as — nėra
   *  eilutės, ne nulinė eilutė. */
  rows: CohortRow[];
  /** Per-protocol: ta pati agregacija pagal {@link AppliedArm} — „ar kompiliuotas kūnas
   *  realiai išėjo". Canary task'as su raw-fallback čia niekada nepapildo `compressed`. */
  appliedRows: CohortRow<AppliedArm>[];
  /** Skirtingi canary task'ai per REALŲ feature vardą — fallback markeris čia niekada
   *  nepasirodo (jis vardija fallback įvykį, ne testuojamą feature). */
  featureBreakdown: Array<{ feature: string; n: number }>;
  /**
   * Human-review baigtys pagal priežastį (0037): `humanReviewRate` atsako „kiek dažnai canary
   * arm'as kainavo žmogaus pass'ą", o čia — „kiek to yra įrodymas prieš kompresiją". Pirmas —
   * kohortos metrika, antras — kill-switch įvestis; jų suplakimas arrest'indavo features už
   * infrastruktūros defektus, prie kurių jos neprisidėjo.
   */
  humanReviewAttribution: CompressionCohortAttributionReport;
  /** Tokenizer-unfriendly įrodymai (0042); visada masyvas. */
  tokenizerUnfriendlySignals: TokenizerUnfriendlySignal[];
  /**
   * Usage, atidėta attempt-scoped join'o (0046) vietoje spėjimo į arm'ą: task_id su >1
   * bandymo tapatybe, kur dalis usage nepavyko priskirti arm'ą nusprendusiam bandymui.
   */
  legacy: LegacyAttemptGroup;
};

/** Neparse'inami/nesami timestamp'ai rikiuojasi seniausi; tada sprendžia append tvarka. */
function timeMs(ts: string | undefined): number {
  const parsed = Date.parse(ts ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function taskIdOf(record: { task_id?: unknown }): string {
  return typeof record.task_id === "string" ? record.task_id.trim() : "";
}

function normalizeFeatures(features: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(features)) return [];
  return features
    .filter((feature): feature is string => typeof feature === "string")
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);
}

/** Keturi skaitmenys po kablelio — `hit_ratio` konvencija. */
function rate(hits: number, total: number): number {
  return Math.round((hits / total) * 10_000) / 10_000;
}

/**
 * Vėliausias lifecycle ĮVYKIS per task'ą; lygiąsias laužo append tvarka. Įvykis be state nėra
 * lifecycle stebėjimas ir praleidžiamas — negali tyliai padidinti human-review vardiklio.
 * Laikomas VISAS įvykis: signatūra skaitoma nuo to paties įvykio, kuris nusprendė state —
 * skaitymas nuo ankstesnio (persverto) įvykio atributuotų baigtį klaidai, iš kurios task'as
 * atsigavo.
 */
function latestEventByTask(events: readonly CohortTaskEvent[]): Map<string, CohortTaskEvent> {
  const byTask = new Map<string, { event: CohortTaskEvent; at: number }>();
  for (const event of events) {
    const taskId = taskIdOf(event);
    const state = typeof event.to_state === "string" ? event.to_state.trim() : "";
    if (!taskId || !state) continue;
    const at = timeMs(event.ts);
    const current = byTask.get(taskId);
    if (!current || at >= current.at) byTask.set(taskId, { event, at });
  }
  return new Map([...byTask].map(([taskId, value]) => [taskId, value.event]));
}

function stateOf(event: CohortTaskEvent): string {
  return typeof event.to_state === "string" ? event.to_state.trim() : "";
}

function buildRow<Arm extends string>(
  arm: Arm,
  taskIds: readonly string[],
  assignments: Map<string, ArmAssignment>,
  usageByTask: Map<string, TaskUsage>,
  stateByTask: Map<string, string>,
): CohortRow<Arm> {
  const usages = taskIds.flatMap((taskId) => {
    const usage = usageByTask.get(taskId);
    return usage ? [usage] : [];
  });
  // Task'as, kurio visa usage istorija sumuojasi į nulį, buvo NEAPSKAITYTAS (žinoma
  // stream-cut skylė), o ne nieko nekainavęs — tokių nulių lankstymas į medianą nuvertintų
  // tą arm'ą, kuriame jie atsidūrė.
  const billableValues = usages.filter((usage) => usage.billableTokens > 0).map((usage) => usage.billableTokens);
  const turnValues = usages.filter((usage) => usage.turnsMeasured).map((usage) => usage.turns);
  const observedStates = taskIds.flatMap((taskId) => {
    const state = stateByTask.get(taskId);
    return state === undefined ? [] : [state];
  });

  const n = taskIds.length;
  const row: CohortRow<Arm> = {
    arm,
    n,
    dispatchCount: taskIds.reduce((sum, taskId) => sum + (assignments.get(taskId)?.dispatchCount ?? 0), 0),
    insufficientSample: n < COHORT_MIN_SAMPLE,
    samples: {
      billable: billableValues.length,
      turns: turnValues.length,
      humanReview: observedStates.length,
      repair: usages.length,
    },
  };
  // Kiekviena metrika vartuojama SAVO sample'u — `n >= COHORT_MIN_SAMPLE` niekada neįneša
  // percentilio iš dviejų išmatuojamų task'ų. (exactOptionalPropertyTypes: mediana virš
  // netuščio sample'o visada apibrėžta, bet TS to nežino — todėl lokalus kintamasis.)
  const billableP50 = median(billableValues);
  if (billableValues.length >= COHORT_MIN_SAMPLE && billableP50 !== undefined) row.billableTokensP50 = billableP50;
  const turnsP50 = median(turnValues);
  if (turnValues.length >= COHORT_MIN_SAMPLE && turnsP50 !== undefined) row.turnsP50 = turnsP50;
  if (observedStates.length >= COHORT_MIN_SAMPLE) {
    row.humanReviewRate = rate(observedStates.filter((state) => state === "human-review").length, observedStates.length);
  }
  if (usages.length >= COHORT_MIN_SAMPLE) {
    row.repairRate = rate(usages.filter((usage) => usage.repaired).length, usages.length);
  }
  return row;
}

/**
 * Atributuoja kiekvieną canary task'ą, kurio VĖLIAUSIAS lifecycle įvykis — human-review.
 * `appliedArm` daro `compression_effect` sąžiningu: raw-fallback task'as niekada netampa
 * įrodymu prieš feature, po kuriuo jis nebuvo paleistas. `control` task'as praleidžiamas —
 * arrest'as teisia canary arm'ą.
 */
function attributeHumanReviewOutcomes(
  assignments: Map<string, ArmAssignment>,
  eventByTask: Map<string, CohortTaskEvent>,
): AttributedCanaryOutcome[] {
  const outcomes: AttributedCanaryOutcome[] = [];
  for (const [taskId, assignment] of assignments) {
    if (assignment.assignmentArm !== "canary") continue;
    const event = eventByTask.get(taskId);
    if (!event || stateOf(event) !== "human-review") continue;
    outcomes.push(
      attributeCanaryOutcome({
        taskId,
        compressionApplied: assignment.features,
        compressionEffect: assignment.appliedArm === "compressed" ? "compiled" : "raw-fallback",
        failurePhase: event.phase ?? null,
        failureReason: event.reason,
        exitCode: event.exit_code,
      }),
    );
  }
  return outcomes;
}

/**
 * Fold'ina atributuotas baigtis į tris bucket'us, per feature ir bendrai. Feature su cohort
 * task'ais bet be human-review baigties čia vis tiek gauna nulių eilutę — „šis feature buvo
 * stebimas ir prieš jį nieko nepalaikyta" yra IŠMATUOTAS rezultatas, o tuščias arm'as — jo
 * nebuvimas.
 */
function buildAttributionReport(
  outcomes: readonly AttributedCanaryOutcome[],
  featuresInCohort: readonly string[],
): CompressionCohortAttributionReport {
  const totals: HumanReviewAttributionBucket = { arrestCounted: 0, warningOnly: 0, unattributed: 0 };
  const byFeature = new Map<string, FeatureHumanReviewAttribution>(
    featuresInCohort.map((feature) => [
      feature,
      { feature, arrestCounted: 0, warningOnly: 0, unattributed: 0, arrestCountedTaskIds: [] },
    ]),
  );
  const rules = new Map<string, number>();

  for (const outcome of outcomes) {
    const bucket: keyof HumanReviewAttributionBucket = isArrestCountableAttribution(outcome.failure_attribution)
      ? "arrestCounted"
      : outcome.failure_attribution === "unrelated"
        ? "warningOnly"
        : "unattributed";
    totals[bucket] += 1;
    // Taisyklė registruojama KIEKVIENAI baigčiai, įskaitant suskaičiuotas: „kodėl šis feature
    // arrest'intas" reikalauja to paties vardinio įrodymo kaip „kodėl ne".
    rules.set(outcome.attribution_rule, (rules.get(outcome.attribution_rule) ?? 0) + 1);
    for (const feature of new Set(outcome.compression_applied)) {
      const row = byFeature.get(feature)
        ?? { feature, arrestCounted: 0, warningOnly: 0, unattributed: 0, arrestCountedTaskIds: [] };
      row[bucket] += 1;
      if (bucket === "arrestCounted") row.arrestCountedTaskIds.push(outcome.task_id);
      byFeature.set(feature, row);
    }
  }

  return {
    totals,
    byFeature: [...byFeature.values()].sort(
      (left, right) => right.arrestCounted - left.arrestCounted || left.feature.localeCompare(right.feature),
    ),
    rules: [...rules]
      .map(([rule, n]) => ({ rule, n }))
      .sort((left, right) => right.n - left.n || left.rule.localeCompare(right.rule)),
  };
}

/**
 * Sujungia canary markerį su task baigtimis per `task_id` ir grąžina arm palyginimą.
 * Nesami įėjimai nėra klaida: be context-size įrašų nėra apie ką kalbėti ir raportas
 * tuščias — teisingas atsakymas, o ne nulinis.
 */
export function buildCompressionCohortReport(
  contextSizeRecords: readonly CohortContextSizeRecord[],
  tokenUsageRecords: readonly CohortTokenUsageRecord[],
  taskEvents: readonly CohortTaskEvent[],
  now: Date = new Date(),
  postRunRows: readonly CohortPostRunRow[] = [],
): CompressionCohortReport {
  const { assignments, usageByTask, legacy } = joinAttemptScopedCohort(contextSizeRecords, tokenUsageRecords);
  const eventByTask = latestEventByTask(taskEvents);
  const stateByTask = new Map([...eventByTask].map(([taskId, event]) => [taskId, stateOf(event)]));

  const taskIdsByAssignmentArm = new Map<AssignmentArm, string[]>([["canary", []], ["control", []]]);
  const taskIdsByAppliedArm = new Map<AppliedArm, string[]>([
    ["compressed", []],
    ["raw-fallback", []],
    ["control", []],
  ]);
  const tasksByFeature = new Map<string, number>();
  for (const [taskId, assignment] of assignments) {
    taskIdsByAssignmentArm.get(assignment.assignmentArm)?.push(taskId);
    taskIdsByAppliedArm.get(assignment.appliedArm)?.push(taskId);
    for (const feature of new Set(assignment.features)) {
      tasksByFeature.set(feature, (tasksByFeature.get(feature) ?? 0) + 1);
    }
  }

  const featureBreakdown = [...tasksByFeature]
    .map(([feature, n]) => ({ feature, n }))
    .sort((left, right) => right.n - left.n || left.feature.localeCompare(right.feature));

  return {
    generatedAt: now.toISOString(),
    rows: [...taskIdsByAssignmentArm]
      // Tuščias arm'as praleidžiamas visai: nulių eilutė skaitosi kaip išmatuotas rezultatas.
      .filter(([, taskIds]) => taskIds.length > 0)
      .map(([arm, taskIds]) => buildRow(arm, taskIds, assignments, usageByTask, stateByTask)),
    appliedRows: [...taskIdsByAppliedArm]
      .filter(([, taskIds]) => taskIds.length > 0)
      .map(([arm, taskIds]) => buildRow(arm, taskIds, assignments, usageByTask, stateByTask)),
    featureBreakdown,
    tokenizerUnfriendlySignals: findTokenizerUnfriendlySignals(assignments, postRunRows, COHORT_MIN_SAMPLE),
    humanReviewAttribution: buildAttributionReport(
      attributeHumanReviewOutcomes(assignments, eventByTask),
      featureBreakdown.map((entry) => entry.feature),
    ),
    legacy,
  };
}

/**
 * Tolerantiškai parse'intų context-size eilučių projekcija: kanoninis skaitytojas atmeta visą
 * žurnalą dėl vienos sugadintos eilutės (teisinga integralumo keliui), o read-only dashboard'e
 * vienas blogas baitas privalo kainuoti tik savo eilutę. Eilutė be `task_id` ar su ne-sąrašo
 * `canary_features` neguldoma į control — ji išmetama.
 */
export function selectCohortContextSizeRecords(rows: readonly unknown[]): CohortContextSizeRecord[] {
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const record = row as {
      ts?: unknown;
      task_id?: unknown;
      max_context_chars?: unknown;
      canary_features?: unknown;
      run_id?: unknown;
      worker_id?: unknown;
      runtime_attempt_id?: unknown;
    };
    const taskId = typeof record.task_id === "string" ? record.task_id.trim() : "";
    if (!taskId) return [];
    if (record.canary_features !== undefined && !Array.isArray(record.canary_features)) return [];
    return [{
      ts: typeof record.ts === "string" ? record.ts : "",
      task_id: taskId,
      // 154-a-02: be šio lauko dashboard'o kelias nemato `describesContextPack` taisyklės ir
      // sintetinė finalize eilutė vėl perrašo pack'o arm'ą. Blogo tipo reikšmė IŠMETAMA, ne
      // koercijuojama — eilutė lieka „ne pack'as", o ne pack'as su išgalvotu biudžetu.
      ...(typeof record.max_context_chars === "number" && Number.isFinite(record.max_context_chars)
        ? { max_context_chars: record.max_context_chars }
        : {}),
      canary_features: normalizeFeatures(record.canary_features as readonly string[] | undefined),
      // 0046: tapatybė pernešama tik kai rašytojas ją realiai pagamino (0045) — pre-0045
      // eilutė lieka teisingai legacy, o ne gauna tuščios eilutės tapatybę.
      ...(typeof record.run_id === "string" ? { run_id: record.run_id } : {}),
      ...(typeof record.worker_id === "string" ? { worker_id: record.worker_id } : {}),
      ...(typeof record.runtime_attempt_id === "string" ? { runtime_attempt_id: record.runtime_attempt_id } : {}),
    }];
  });
}

/**
 * Ta pati tolerantiška projekcija task-events eilutėms: be `task_id` — nėra eilutės.
 * `phase`/`reason`/`exit_code` paliekami tik su rašytojo tipu; blogo tipo laukas IŠMETAMAS,
 * ne koercijuojamas — stringifikuota `reason` duotų atribucijos lentelei tekstą, kurio joks
 * rašytojas neemitavo.
 */
export function selectCohortTaskEvents(rows: readonly unknown[]): CohortTaskEvent[] {
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const record = row as {
      ts?: unknown;
      task_id?: unknown;
      to_state?: unknown;
      phase?: unknown;
      reason?: unknown;
      exit_code?: unknown;
    };
    const taskId = typeof record.task_id === "string" ? record.task_id.trim() : "";
    if (!taskId) return [];
    return [{
      ts: typeof record.ts === "string" ? record.ts : "",
      task_id: taskId,
      to_state: typeof record.to_state === "string" ? record.to_state : "",
      ...(typeof record.phase === "string" ? { phase: record.phase } : {}),
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(typeof record.exit_code === "number" && Number.isFinite(record.exit_code)
        ? { exit_code: record.exit_code }
        : {}),
    }];
  });
}
