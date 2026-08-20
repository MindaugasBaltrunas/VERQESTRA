// VQ-305 (3/3-d): compression cohort analitikos unit testai — arm assignment (latest-wins,
// fallback markeris), usage sumavimas, attempt-scoped atribucijos korekcija (0046),
// tokenizer-unfriendly signalas (0042), raporto agregacija su per-metrikos sample vartais ir
// tolerantiškos žurnalų projekcijos. Grynos funkcijos — jokio IO.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assignArms,
  attemptIdentityKey,
  joinAttemptScopedCohort,
  splitByAttemptIdentity,
  summarizeUsageByTask,
} from "../application/analytics/attempt-identity-join.js";
import {
  buildCompressionCohortReport,
  selectCohortContextSizeRecords,
  selectCohortTaskEvents,
  COHORT_MIN_SAMPLE,
  type CohortContextSizeRecord,
  type CohortTokenUsageRecord,
  type CohortTaskEvent,
} from "../application/analytics/compression-cohorts.js";
import {
  findTokenizerUnfriendlySignals,
  median,
  type TokenizerSignalArmAssignment,
} from "../application/analytics/tokenizer-unfriendly-signal.js";
import { CANARY_SIZE_FALLBACK_MARKER } from "../application/context-pack/metrics.js";

const T0 = "2026-08-20T08:00:00Z";
const T1 = "2026-08-20T09:00:00Z";

function ctx(taskId: string, features: string[], ts = T0, identity?: { run: string; worker: string; attempt: string }): CohortContextSizeRecord {
  return {
    ts,
    task_id: taskId,
    canary_features: features,
    ...(identity ? { run_id: identity.run, worker_id: identity.worker, runtime_attempt_id: identity.attempt } : {}),
  };
}

function usage(taskId: string, tokens: number, extra: Partial<CohortTokenUsageRecord> = {}): CohortTokenUsageRecord {
  return { task_id: taskId, input_tokens: tokens, ...extra };
}

function event(taskId: string, state: string, ts = T0, extra: Partial<CohortTaskEvent> = {}): CohortTaskEvent {
  return { ts, task_id: taskId, to_state: state, ...extra };
}

test("median ir attempt tapatybės primityvai", () => {
  assert.equal(median([]), undefined);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);

  assert.equal(attemptIdentityKey({ task_id: "t", run_id: "r", worker_id: "w", runtime_attempt_id: "a1" }), "rwta1");
  assert.equal(attemptIdentityKey({ task_id: "t", run_id: "r", worker_id: " ", runtime_attempt_id: "a1" }), null);

  const split = splitByAttemptIdentity([
    { task_id: "t", run_id: "r", worker_id: "w", runtime_attempt_id: "a1" },
    { task_id: "t" },
  ]);
  assert.equal(split.byAttempt.get("rwta1")?.length, 1);
  assert.equal(split.legacy.length, 1);
});

test("assignArms: latest-wins, dispatchCount ir fallback markerio semantika", () => {
  const assignments = assignArms([
    ctx("0001", ["symbol_slices"], T0),
    ctx("0001", [], T1),
    ctx("0002", ["symbol_slices", CANARY_SIZE_FALLBACK_MARKER], T0),
    ctx("0003", [], T0),
  ]);
  const flipped = assignments.get("0001");
  assert.equal(flipped?.assignmentArm, "control", "vėliausias įrašas laimi");
  assert.equal(flipped?.dispatchCount, 2);

  const fallback = assignments.get("0002");
  assert.equal(fallback?.assignmentArm, "canary", "markeris nenusprendžia priskyrimo");
  assert.equal(fallback?.appliedArm, "raw-fallback", "bet applied arm'as — raw-fallback");
  assert.deepEqual(fallback?.features, ["symbol_slices"], "markeris nuimtas iš features");

  assert.equal(assignments.get("0003")?.appliedArm, "control");
});

test("summarizeUsageByTask: billable be cache_read, turnsMeasured ir repair formos", () => {
  const byTask = summarizeUsageByTask([
    usage("0001", 100, { output_tokens: 50, cache_creation_input_tokens: 10, num_turns: 3 }),
    usage("0001", 40),
    usage("0002", 10, { attempt: 2 }),
    usage("0003", 10, { retry_reason: "tests" }),
    usage("0004", 10, { task_phase: "repair" }),
    usage("0005", 10),
  ]);
  const first = byTask.get("0001");
  assert.equal(first?.billableTokens, 200);
  assert.equal(first?.turns, 3);
  assert.equal(first?.turnsMeasured, true);
  assert.equal(first?.repaired, false);
  assert.equal(byTask.get("0005")?.turnsMeasured, false, "be num_turns — ne nulio turn'ų task'as");
  for (const taskId of ["0002", "0003", "0004"]) {
    assert.equal(byTask.get(taskId)?.repaired, true, `${taskId} repair forma atpažinta`);
  }
});

test("joinAttemptScopedCohort: ambiguous task'o usage atribucija koreguojama, vienareikšmis — ne", () => {
  const id1 = { run: "r1", worker: "w1", attempt: "a1" };
  const id2 = { run: "r1", worker: "w1", attempt: "a2" };
  const contextRecords = [
    // 0001: du bandymai — a1 canary (anksčiau), a2 control (vėliau) → task'o arm'as control.
    ctx("0001", ["symbol_slices"], T0, id1),
    ctx("0001", [], T1, id2),
    // 0002: vienas bandymas — korekcija netaikoma.
    ctx("0002", ["symbol_slices"], T0, id1),
  ];
  const usageRecords = [
    // a1 (canary bandymo) usage — turi būti IŠMESTA iš control arm'o.
    usage("0001", 1000, { run_id: "r1", worker_id: "w1", runtime_attempt_id: "a1" }),
    // a2 (laimėjusio control bandymo) usage — lieka.
    usage("0001", 70, { run_id: "r1", worker_id: "w1", runtime_attempt_id: "a2" }),
    // Be tapatybės ant ambiguous task'o — irgi išmetama.
    usage("0001", 5),
    // Vienareikšmio task'o usage be tapatybės — lieka kaip visada.
    usage("0002", 300),
  ];
  const { assignments, usageByTask, legacy } = joinAttemptScopedCohort(contextRecords, usageRecords);
  assert.equal(assignments.get("0001")?.assignmentArm, "control");
  assert.equal(usageByTask.get("0001")?.billableTokens, 70, "liko tik laimėjusio bandymo usage");
  assert.equal(usageByTask.get("0002")?.billableTokens, 300);
  assert.deepEqual(legacy, { n: 1, excludedUsageRecords: 2 });
});

test("buildCompressionCohortReport: arm'ų eilutės, sample vartai ir atribucijos bucket'ai", () => {
  const contextRecords: CohortContextSizeRecord[] = [];
  const usageRecords: CohortTokenUsageRecord[] = [];
  const events: CohortTaskEvent[] = [];
  // 6 canary (viena — raw-fallback) ir 6 control task'ų su pilnais matavimais.
  for (let index = 1; index <= 6; index += 1) {
    const canaryId = `c${index}`;
    const features = index === 6 ? ["symbol_slices", CANARY_SIZE_FALLBACK_MARKER] : ["symbol_slices"];
    contextRecords.push(ctx(canaryId, features));
    usageRecords.push(usage(canaryId, 100 + index, { num_turns: 4 }));
    events.push(event(canaryId, index === 1 ? "human-review" : "done", T1, index === 1 ? { phase: "diagnosis", reason: "scope violated" } : {}));

    const controlId = `k${index}`;
    contextRecords.push(ctx(controlId, []));
    usageRecords.push(usage(controlId, 200 + index, { num_turns: 6, ...(index === 2 ? { attempt: 2 } : {}) }));
    events.push(event(controlId, "done", T1));
  }

  const report = buildCompressionCohortReport(contextRecords, usageRecords, events, new Date("2026-08-20T10:00:00Z"));
  const canaryRow = report.rows.find((row) => row.arm === "canary");
  const controlRow = report.rows.find((row) => row.arm === "control");
  assert.equal(canaryRow?.n, 6);
  assert.equal(canaryRow?.insufficientSample, false);
  assert.equal(canaryRow?.billableTokensP50, 103.5);
  assert.equal(canaryRow?.humanReviewRate, Math.round((1 / 6) * 10_000) / 10_000);
  assert.equal(controlRow?.repairRate, Math.round((1 / 6) * 10_000) / 10_000);

  const compressedRow = report.appliedRows.find((row) => row.arm === "compressed");
  const fallbackRow = report.appliedRows.find((row) => row.arm === "raw-fallback");
  assert.equal(compressedRow?.n, 5, "raw-fallback task'as nepapildo compressed");
  assert.equal(fallbackRow?.n, 1);
  assert.equal(fallbackRow?.insufficientSample, true);
  assert.equal(fallbackRow?.billableTokensP50, undefined, "per mažas sample slopina percentilį");

  assert.deepEqual(report.featureBreakdown, [{ feature: "symbol_slices", n: 6 }]);
  const buckets = report.humanReviewAttribution.totals;
  assert.equal(buckets.arrestCounted + buckets.warningOnly + buckets.unattributed, 1, "viena canary human-review baigtis");
  assert.equal(report.humanReviewAttribution.byFeature[0]?.feature, "symbol_slices");
  assert.ok(report.humanReviewAttribution.rules.length >= 1, "kiekviena baigtis turi vardinę taisyklę");
  assert.deepEqual(report.legacy, { n: 0, excludedUsageRecords: 0 });

  // Tuščias arm'as praleidžiamas: vien canary įrašai → control eilutės nėra.
  const onlyCanary = buildCompressionCohortReport([ctx("c1", ["f"])], [], []);
  assert.deepEqual(onlyCanary.rows.map((row) => row.arm), ["canary"]);
});

test("tokenizer-unfriendly signalas: chars sumažėjo, tokenai ne — tik su pakankamu control sample", () => {
  const assignments = new Map<string, TokenizerSignalArmAssignment>();
  for (let index = 0; index < 5; index += 1) {
    assignments.set(`k${index}`, { assignmentArm: "control", features: [] });
  }
  assignments.set("c1", { assignmentArm: "canary", features: ["symbol_slices"] });
  const postRun = [
    ...Array.from({ length: 5 }, (_, index) => ({ task_id: `k${index}`, raw_chars: 100, compiled_chars: 100, input_tokens: 100 })),
    { task_id: "c1", raw_chars: 200, compiled_chars: 150, input_tokens: 120 },
  ];
  const signals = findTokenizerUnfriendlySignals(assignments, postRun, COHORT_MIN_SAMPLE);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.feature, "symbol_slices");
  assert.equal(signals[0]?.controlMedianInputTokens, 100);

  assert.deepEqual(findTokenizerUnfriendlySignals(assignments, postRun.slice(2), COHORT_MIN_SAMPLE), [], "<5 control — tyla");
  const shrunkTokens = [...postRun.slice(0, 5), { task_id: "c1", raw_chars: 200, compiled_chars: 150, input_tokens: 50 }];
  assert.deepEqual(findTokenizerUnfriendlySignals(assignments, shrunkTokens, COHORT_MIN_SAMPLE), [], "tokenai sumažėjo — ne signalas");
});

test("tolerantiškos projekcijos: blogos eilutės krenta po vieną, tipai nekoercijuojami", () => {
  const contextRows = selectCohortContextSizeRecords([
    { task_id: "0001", canary_features: ["f"], run_id: "r", worker_id: "w", runtime_attempt_id: "a1" },
    { task_id: "0002", canary_features: "ne-masyvas" },
    { task_id: "  " },
    null,
    { task_id: "0003" },
  ]);
  assert.deepEqual(contextRows.map((row) => row.task_id), ["0001", "0003"]);
  assert.equal(contextRows[0]?.run_id, "r", "tapatybė pernešta kai yra");
  assert.equal(contextRows[1]?.run_id, undefined, "pre-0045 eilutė be tuščios tapatybės");

  const events = selectCohortTaskEvents([
    { task_id: "0001", to_state: "human-review", phase: "diagnosis", reason: "x", exit_code: 1 },
    { task_id: "0002", to_state: "done", reason: { ne: "string" } },
    { to_state: "done" },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.reason, "x");
  assert.equal(events[1]?.reason, undefined, "blogo tipo reason IŠMESTAS, ne stringifikuotas");
});
