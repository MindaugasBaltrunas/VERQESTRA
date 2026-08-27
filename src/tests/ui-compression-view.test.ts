// Task 032-a-02: `decideCompression` persijungia prie prompt'o lygio shadow poros
// (`raw_prompt_chars`/`compiled_prompt_chars`, task 0032 `persist.ts`), kai ji mėginiuose YRA;
// kai nėra — grįžta prie senosios `raw_task_chars`/`compiled_task_chars` poros be lūžio.
// Slenksčio logika (`MIN_DECISION_SAMPLES`, spaudimo lygiai) NESIKEIČIA — testuojama tik
// pora ir jos matomumas verdikto rezultate.

import assert from "node:assert/strict";
import test from "node:test";
import {
  decideCompression,
  MIN_DECISION_SAMPLES,
  summarizeContextSizeSamples,
  type ContextSizeSample,
} from "../interfaces/http/ui-compression-view.js";

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
