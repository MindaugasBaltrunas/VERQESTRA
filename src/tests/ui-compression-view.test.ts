// Task 032-a-02: `decideCompression` persijungia prie prompt'o lygio shadow poros
// (`raw_prompt_chars`/`compiled_prompt_chars`, task 0032 `persist.ts`), kai ji mėginiuose YRA;
// kai nėra — grįžta prie senosios `raw_task_chars`/`compiled_task_chars` poros be lūžio.
// Slenksčio logika (`MIN_DECISION_SAMPLES`, spaudimo lygiai) NESIKEIČIA — testuojama tik
// pora ir jos matomumas verdikto rezultate.

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompressionView,
  decideCompression,
  MIN_DECISION_SAMPLES,
  summarizeContextSizeSamples,
  type ContextSizeSample,
} from "../interfaces/http/ui-compression-view.js";
import {
  defaultContextCompressionConfig,
  type ContextCompressionConfig,
} from "../domain/policies/compression/features.js";

function config(overrides: Partial<ContextCompressionConfig["features"]> = {}): ContextCompressionConfig {
  const base = defaultContextCompressionConfig();
  return { ...base, features: { ...base.features, ...overrides } };
}

// Task 055: `resolveCompressionFeatureDependencies` fail-closed išjungia `compact_dsl`, kai jo
// priklausomybė `worker_task_ir` yra `false` — bet TIK vykdymo metu, per efektyvų konfigą. Ši
// projekcija skaito AUTORINĮ (nerezoliuotą) konfigą, tad ji privalo pati įvardyti tą pačią
// priklausomybę, kitaip UI rodo `compact_dsl=true` kaip veikiantį, nors realiai jis nebus taikomas.
test("buildCompressionView: compact_dsl deklaruotas true, worker_task_ir false -> inactive_reason užpildytas", async () => {
  const view = await buildCompressionView({
    loadConfig: async () => config({ compact_dsl: true, worker_task_ir: false }),
    readContextSizeLog: async () => undefined,
  });

  const compactDsl = view.features.find((f) => f.key === "compact_dsl");
  assert.equal(compactDsl?.value, true, "deklaruota reikšmė lieka matoma — tik pažymima kaip neveiksni");
  assert.deepEqual(compactDsl?.requires, ["worker_task_ir"]);
  assert.equal(compactDsl?.inactive_reason, "inactive_due_to_dependency");
});

test("buildCompressionView: worker_task_ir=true -> compact_dsl neturi inactive_reason lauko", async () => {
  const view = await buildCompressionView({
    loadConfig: async () => config({ compact_dsl: true, worker_task_ir: true }),
    readContextSizeLog: async () => undefined,
  });

  const compactDsl = view.features.find((f) => f.key === "compact_dsl");
  assert.ok(!("inactive_reason" in (compactDsl ?? {})), "priklausomybė patenkinta — lauko nebūna");
});

test("buildCompressionView: compact_dsl=false -> inactive_reason nebūna, nors worker_task_ir taip pat false", async () => {
  const view = await buildCompressionView({
    loadConfig: async () => config({ compact_dsl: false, worker_task_ir: false }),
    readContextSizeLog: async () => undefined,
  });

  const compactDsl = view.features.find((f) => f.key === "compact_dsl");
  assert.ok(
    !("inactive_reason" in (compactDsl ?? {})),
    "operatorius pats išjungė vėliavą — tai ne priklausomybės sukeltas fail-closed",
  );
});

test("buildCompressionView: vėliavos be deklaruotų priklausomybių neturi requires lauko", async () => {
  const view = await buildCompressionView({
    loadConfig: async () => config(),
    readContextSizeLog: async () => undefined,
  });

  const workerTaskIr = view.features.find((f) => f.key === "worker_task_ir");
  assert.ok(!("requires" in (workerTaskIr ?? {})));
});

const TASK_PAIR_SAMPLE: ContextSizeSample = {
  ts: "2026-08-26T08:25:57.730Z",
  context_chars: 7042,
  max_context_chars: 12000,
  raw_task_chars: 964,
  compiled_task_chars: 1686,
  exceeded: false,
};

const PROMPT_PAIR_SAMPLE: ContextSizeSample = {
  ts: "2026-08-27T08:25:57.730Z",
  context_chars: 7042,
  max_context_chars: 12000,
  // Task'o lygio pora IR YRA (senas rašytojas gali rašyti abu) — prompt'o pora vis tiek laimi.
  raw_task_chars: 964,
  compiled_task_chars: 1686,
  raw_prompt_chars: 5000,
  compiled_prompt_chars: 2500,
  exceeded: false,
};

test("summarizeContextSizeSamples: prompt'o pora turi pirmenybę, kai mėginys ją turi", () => {
  const summary = summarizeContextSizeSamples([PROMPT_PAIR_SAMPLE]);

  assert.equal(summary.ir_compared_count, 1);
  assert.equal(summary.ir_smaller_count, 1, "5000 → 2500 yra sumažėjimas");
  assert.equal(summary.avg_ir_delta_percent, -50, "delta skaičiuojama nuo PROMPT'O poros, ne task'o");
  assert.equal(summary.ir_pair, "prompt");
});

test("summarizeContextSizeSamples: be prompt'o poros mėginyje — fallback prie task'o poros", () => {
  const summary = summarizeContextSizeSamples([TASK_PAIR_SAMPLE]);

  assert.equal(summary.ir_compared_count, 1);
  assert.equal(summary.avg_ir_delta_percent, 74.9, "delta skaičiuojama nuo TASK'O poros — senas elgesys");
  assert.equal(summary.ir_pair, "task");
});

test("summarizeContextSizeSamples: mišrūs mėginiai — prompt'o pora bet kuriame mėginyje laimi bendrą lauką", () => {
  const summary = summarizeContextSizeSamples([TASK_PAIR_SAMPLE, PROMPT_PAIR_SAMPLE]);

  assert.equal(summary.ir_compared_count, 2, "abu mėginiai turi po vieną naudojamą porą");
  assert.equal(summary.ir_pair, "prompt", "bent vienas mėginys naudojo prompt'o porą");
});

test("summarizeContextSizeSamples: jokio palyginimo — ir_pair NEBŪNA (undefined), ne 'task' pagal nutylėjimą", () => {
  const summary = summarizeContextSizeSamples([{ ts: "x", context_chars: 1 }]);

  assert.equal(summary.ir_compared_count, 0);
  assert.equal(summary.ir_pair, undefined);
  assert.ok(!("ir_pair" in summary), "laukas neturi egzistuoti, kai nėra ką įvardyti");
});

test("decideCompression: verdikto rezultate matomas laukas, kuri pora buvo naudota", () => {
  const promptSummary = summarizeContextSizeSamples(Array(MIN_DECISION_SAMPLES).fill(PROMPT_PAIR_SAMPLE));
  const promptDecision = decideCompression(promptSummary);
  const promptIr = promptDecision.recommendations.find((r) => r.key === "worker_task_ir");
  assert.equal(promptIr?.pair, "prompt");

  const taskSummary = summarizeContextSizeSamples(Array(MIN_DECISION_SAMPLES).fill(TASK_PAIR_SAMPLE));
  const taskDecision = decideCompression(taskSummary);
  const taskIr = taskDecision.recommendations.find((r) => r.key === "worker_task_ir");
  assert.equal(taskIr?.pair, "task");
});

test("decideCompression: slenksčio logika (MIN_DECISION_SAMPLES, spaudimo lygiai) NESIKEIČIA su prompt'o pora", () => {
  // Per mažai prompt'o poros palyginimų -> verdiktas vis tiek atsisakomas, kaip ir su senąja pora.
  const thin = summarizeContextSizeSamples(Array(MIN_DECISION_SAMPLES - 1).fill(PROMPT_PAIR_SAMPLE));
  assert.equal(decideCompression(thin).recommendations[0]?.action, "insufficient");

  // Pakankamai mėginių, prompt'o pora mažesnė, jokio spaudimo (58.7% < 60%) -> "optional", ne "enable".
  const enough = summarizeContextSizeSamples(Array(MIN_DECISION_SAMPLES).fill(PROMPT_PAIR_SAMPLE));
  const decision = decideCompression(enough);
  assert.equal(decision.pressure.level, "none");
  assert.equal(decision.recommendations.find((r) => r.key === "worker_task_ir")?.action, "optional");
});

test("decideCompression: be jokio IR palyginimo laukas 'pair' rekomendacijoje NEBŪNA", () => {
  const summary = summarizeContextSizeSamples([]);
  const decision = decideCompression(summary);
  const ir = decision.recommendations.find((r) => r.key === "worker_task_ir");
  assert.ok(ir && !("pair" in ir), "nėra ką įvardyti, kai palyginimų apskritai nebuvo");
});

// Task 036-e-06: FEATURE_PAIR_SELECTORS apibendrina selectIrPair likusioms keturioms vėliavoms —
// kiekviena gauna savo fiksuotą (raw, compiled) lauko porą, be prompt/task fallback'o.
const DSL_PAIR_SAMPLE: ContextSizeSample = { ts: "x", dsl_ir_chars: 1000, dsl_compiled_chars: 400 };
const SYMBOL_PAIR_SAMPLE: ContextSizeSample = { ts: "x", symbol_source_chars: 1000, symbol_signature_chars: 200 };
const TOOL_DIGEST_PAIR_SAMPLE: ContextSizeSample = { ts: "x", tool_raw_chars: 1000, tool_digest_chars: 700 };
const TOOL_SCHEMA_PAIR_SAMPLE: ContextSizeSample = {
  ts: "x",
  tool_schema_full_chars: 1000,
  tool_schema_reduced_chars: 1200,
};

test("summarizeContextSizeSamples: kiekviena iš keturių likusių vėliavų gauna savo feature_pairs įrašą", () => {
  const summary = summarizeContextSizeSamples([DSL_PAIR_SAMPLE, SYMBOL_PAIR_SAMPLE, TOOL_DIGEST_PAIR_SAMPLE, TOOL_SCHEMA_PAIR_SAMPLE]);

  assert.equal(summary.feature_pairs?.compact_dsl?.compared_count, 1);
  assert.equal(summary.feature_pairs?.compact_dsl?.avg_delta_percent, -60);
  assert.equal(summary.feature_pairs?.symbol_slices?.compared_count, 1);
  assert.equal(summary.feature_pairs?.symbol_slices?.avg_delta_percent, -80);
  assert.equal(summary.feature_pairs?.bash_output_digest?.compared_count, 1);
  assert.equal(summary.feature_pairs?.bash_output_digest?.avg_delta_percent, -30);
  assert.equal(summary.feature_pairs?.dispatch_tool_schema?.compared_count, 1);
  assert.equal(summary.feature_pairs?.dispatch_tool_schema?.avg_delta_percent, 20, "reduced > full — čia augimas, ne nauda");
  assert.ok(!("worker_task_ir" in (summary.feature_pairs ?? {})), "worker_task_ir naudoja savo ir_* laukus, ne feature_pairs");
});

test("summarizeContextSizeSamples: vėliava be jokios poros mėginiuose NEATSIRANDA feature_pairs", () => {
  const summary = summarizeContextSizeSamples([DSL_PAIR_SAMPLE]);
  assert.ok(!("symbol_slices" in (summary.feature_pairs ?? {})));
});

test("decideCompression: vėliava su pakankamai mažėjančių palyginimų ir spaudimu gauna 'enable'", () => {
  const summary = summarizeContextSizeSamples([
    ...Array(MIN_DECISION_SAMPLES).fill(DSL_PAIR_SAMPLE),
    { ts: "x", context_chars: 11000, max_context_chars: 12000, exceeded: true },
  ]);
  const decision = decideCompression(summary);
  assert.equal(decision.pressure.level, "high");
  const dsl = decision.recommendations.find((r) => r.key === "compact_dsl");
  assert.deepEqual(dsl, { key: "compact_dsl", action: "enable", reason: "smaller-under-pressure" });
  assert.ok(dsl && !("pair" in dsl), "fiksuotai porai nėra ko įvardyti");
});

test("decideCompression: vėliava su pakankamai mažėjančių palyginimų, be spaudimo gauna 'optional'", () => {
  const summary = summarizeContextSizeSamples(Array(MIN_DECISION_SAMPLES).fill(SYMBOL_PAIR_SAMPLE));
  const decision = decideCompression(summary);
  assert.equal(decision.pressure.level, "none", "context_chars/max_context_chars nėra šiuose mėginiuose");
  const symbol = decision.recommendations.find((r) => r.key === "symbol_slices");
  assert.deepEqual(symbol, { key: "symbol_slices", action: "optional", reason: "smaller-no-pressure" });
});

test("decideCompression: vėliava, kur compiled VIDUTINIŠKAI didesnis, gauna 'hold'", () => {
  const summary = summarizeContextSizeSamples(Array(MIN_DECISION_SAMPLES).fill(TOOL_SCHEMA_PAIR_SAMPLE));
  const decision = decideCompression(summary);
  const schema = decision.recommendations.find((r) => r.key === "dispatch_tool_schema");
  assert.deepEqual(schema, { key: "dispatch_tool_schema", action: "hold", reason: "larger-on-average" });
});

test("decideCompression: vėliava su per mažai palyginimų gauna 'insufficient', ne 'unmeasured'", () => {
  const summary = summarizeContextSizeSamples(Array(MIN_DECISION_SAMPLES - 1).fill(TOOL_DIGEST_PAIR_SAMPLE));
  const decision = decideCompression(summary);
  const digest = decision.recommendations.find((r) => r.key === "bash_output_digest");
  assert.deepEqual(digest, { key: "bash_output_digest", action: "insufficient", reason: "too-few-comparisons" });
});

test("decideCompression: worker_task_ir verdiktas nesikeičia, kai kitos vėliavos turi savo shadow poras", () => {
  const withoutOthers = decideCompression(summarizeContextSizeSamples(Array(MIN_DECISION_SAMPLES).fill(PROMPT_PAIR_SAMPLE)));
  const mixedSample: ContextSizeSample = { ...PROMPT_PAIR_SAMPLE, ...DSL_PAIR_SAMPLE };
  const withOthers = decideCompression(summarizeContextSizeSamples(Array(MIN_DECISION_SAMPLES).fill(mixedSample)));

  const irWithout = withoutOthers.recommendations.find((r) => r.key === "worker_task_ir");
  const irWith = withOthers.recommendations.find((r) => r.key === "worker_task_ir");
  assert.deepEqual(irWith, irWithout, "worker_task_ir yra bitiškai tapatus nepriklausomai nuo kitų vėliavų duomenų");
});
