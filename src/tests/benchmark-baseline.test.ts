// Optimization benchmark capture/baseline testai (VQ-305 3/3-e). Elgesio etalonas:
// AG_loop capture-baseline testai: užšaldyto konfigo hash'as, capture iš telemetrijos,
// markdown round-trip ir palyginimas su baseline.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { compareWithBaseline } from "../application/benchmark/baseline-comparison.js";
import {
  parseBenchmarkReportMarkdown,
  renderBenchmarkReportMarkdown,
  renderBenchmarkReportText,
  writeBenchmarkBaseline,
} from "../application/benchmark/baseline-report.js";
import { captureBenchmarkReport } from "../application/benchmark/capture-baseline.js";
import {
  benchmarkPaths,
  frozenBenchmarkConfigHash,
  loadOptimizationBenchmarkConfig,
  optimizationBenchmarkConfigSchema,
  type BenchmarkCaptureFsPort,
} from "../application/benchmark/optimization-config.js";
import { parseWithSchema } from "../shared/schema.js";

const ROOT = path.resolve("/repo");
const abs = (rel: string): string => path.join(ROOT, rel).replace(/\\/g, "/");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const PATHS = benchmarkPaths(RUNTIME_ROOT);

function fakeFs(files: Record<string, string>): BenchmarkCaptureFsPort {
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const store = new Map(Object.entries(files));
  return {
    readTextFileIfExists: async (p) => store.get(norm(p)),
    writeTextFile: async (p, content) => {
      store.set(norm(p), content);
    },
    makeDirectory: async () => {},
  };
}

const CONFIG_DOC = {
  version: 1,
  frozen_at: "2026-08-01",
  spec_source: "vq/project/token-optimization.md",
  primary_metric: "tokens_per_verified_accepted_change",
  token_basis: "total_tokens",
  comparison: { max_token_regression_pct: 10, require_same_config_hash: true, require_clean_integrity: true },
  cases: [
    {
      id: "core-loop",
      category: "core",
      description: "core loop tasks",
      size_class: "small",
      task_id_patterns: ["T-1*"],
      min_tasks: 1,
    },
  ],
};

const USAGE_LINES = [
  JSON.stringify({
    ts: "2026-08-01T00:00:00.000Z",
    phase: "dispatch",
    task_id: "T-10",
    model: "claude-sonnet-5",
    input_tokens: 100,
    output_tokens: 100,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: 0.1,
  }),
  JSON.stringify({
    ts: "2026-08-01T00:05:00.000Z",
    phase: "dispatch",
    task_id: "T-10",
    model: "claude-sonnet-5",
    input_tokens: 200,
    output_tokens: 200,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: 0.2,
  }),
].join("\n");

const EVENT_LINES = [
  JSON.stringify({ task_id: "T-10", to_state: "dispatched", reason: "" }),
  JSON.stringify({ task_id: "T-10", to_state: "done", reason: "verified" }),
].join("\n");

function cleanFiles(): Record<string, string> {
  return {
    [abs("vq/config/optimization-benchmark.json")]: JSON.stringify(CONFIG_DOC),
    [abs("vq/logs/token-usage.jsonl")]: `${USAGE_LINES}\n`,
    [abs("vq/logs/task-events.jsonl")]: `${EVENT_LINES}\n`,
  };
}

const OPTIONS = { runtimeRoot: RUNTIME_ROOT, now: new Date("2026-08-20T12:00:00.000Z") };

test("frozen_hash: neatitikimas yra klaida, o įrašyta teisinga reikšmė priimama", async () => {
  const config = parseWithSchema(optimizationBenchmarkConfigSchema, CONFIG_DOC, "test config");
  const hash = frozenBenchmarkConfigHash(config);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);

  const declared = { ...CONFIG_DOC, frozen_hash: hash };
  const okFs = fakeFs({ [abs("vq/config/optimization-benchmark.json")]: JSON.stringify(declared) });
  const loaded = await loadOptimizationBenchmarkConfig(okFs, PATHS.configPath);
  assert.equal(loaded.hash, hash);

  const badFs = fakeFs({
    [abs("vq/config/optimization-benchmark.json")]: JSON.stringify({
      ...CONFIG_DOC,
      frozen_hash: `sha256:${"0".repeat(64)}`,
    }),
  });
  await assert.rejects(() => loadOptimizationBenchmarkConfig(badFs, PATHS.configPath), /frozen_hash mismatch/);
  await assert.rejects(() => loadOptimizationBenchmarkConfig(fakeFs({}), PATHS.configPath), /config not found/);
});

test("captureBenchmarkReport: švari telemetrija duoda priimtą pakeitimą ir apskaičiuotą metriką", async () => {
  const report = await captureBenchmarkReport(fakeFs(cleanFiles()), OPTIONS);
  assert.equal(report.generated_at, "2026-08-20T12:00:00.000Z");
  assert.deepEqual(report.case_ids, ["core-loop"]);
  assert.equal(report.tasks.length, 1);
  assert.equal(report.tasks[0]!.task_id, "T-10");
  assert.equal(report.totals.usage.total_tokens, 600);
  assert.equal(report.totals.accepted_changes, 1);
  assert.equal(report.tokens_per_verified_accepted_change.status, "computed");
  assert.equal(report.tokens_per_verified_accepted_change.value, 600);
  assert.equal(report.integrity.ok, true);
});

test("sugadinta event eilutė ir nepriskirtas task'as degraduoja į integrity faktus, ne į klaidą", async () => {
  const files = cleanFiles();
  files[abs("vq/logs/task-events.jsonl")] = `${EVENT_LINES}\nnot-json\n`;
  files[abs("vq/logs/token-usage.jsonl")] = `${USAGE_LINES}\n${JSON.stringify({
    phase: "dispatch",
    task_id: "X-99",
    model: "claude-sonnet-5",
    input_tokens: 5,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: 0,
  })}\n`;
  const report = await captureBenchmarkReport(fakeFs(files), OPTIONS);
  assert.equal(report.integrity.malformed_event_lines, 1);
  assert.deepEqual(report.integrity.unassigned_task_ids, ["X-99"]);
  assert.equal(report.integrity.unassigned_usage_records, 1);
  assert.equal(report.integrity.unassigned_total_tokens, 10);
  assert.equal(report.integrity.ok, false);
  assert.ok(report.warnings.some((warning) => warning.includes("does not match any frozen benchmark case")));
});

test("nepriskirtas task'as SU usage>0 vienas pats laužia integrity.ok, o usage sumuojamas totals nematomai", async () => {
  const files = cleanFiles();
  files[abs("vq/logs/token-usage.jsonl")] = `${USAGE_LINES}\n${[
    JSON.stringify({
      phase: "dispatch",
      task_id: "X-99",
      model: "claude-sonnet-5",
      input_tokens: 30,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 5,
      total_cost_usd: 0.05,
    }),
    JSON.stringify({
      phase: "dispatch",
      task_id: "X-99",
      model: "claude-sonnet-5",
      input_tokens: 10,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0.01,
    }),
  ].join("\n")}\n`;
  const report = await captureBenchmarkReport(fakeFs(files), OPTIONS);
  assert.equal(report.integrity.malformed_event_lines, 0);
  assert.equal(report.integrity.ambiguous_task_ids.length, 0);
  assert.deepEqual(report.integrity.unassigned_task_ids, ["X-99"]);
  assert.equal(report.integrity.unassigned_usage_records, 2);
  assert.equal(report.integrity.unassigned_total_tokens, 80);
  assert.equal(report.integrity.ok, false, "nepriskirto task'o usage niekada neturi tyliai dingti iš integrity");
  // X-99 usage neturi patekti į measured totals — jis lieka nepriskirtas jokiam case'ui.
  assert.equal(report.totals.usage.total_tokens, 600);
});

test("keli SKIRTINGI nepriskirti task'ai: usage sumuojasi per abu, ne tik per vieną", async () => {
  const files = cleanFiles();
  files[abs("vq/logs/token-usage.jsonl")] = `${USAGE_LINES}\n${[
    JSON.stringify({
      phase: "dispatch",
      task_id: "X-99",
      model: "claude-sonnet-5",
      input_tokens: 30,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0.05,
    }),
    JSON.stringify({
      phase: "dispatch",
      task_id: "X-01",
      model: "claude-sonnet-5",
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0.01,
    }),
  ].join("\n")}\n`;
  const report = await captureBenchmarkReport(fakeFs(files), OPTIONS);
  assert.deepEqual(report.integrity.unassigned_task_ids, ["X-01", "X-99"]);
  assert.equal(report.integrity.unassigned_usage_records, 2);
  assert.equal(report.integrity.unassigned_total_tokens, 60, "60 = (30+20 X-99) + (7+3 X-01), sumuojama per abu task'us");
  assert.equal(report.integrity.ok, false);
  assert.equal(report.totals.usage.total_tokens, 600, "nepriskirtų usage neturi patekti į measured totals");
});

test("nepriskirtas task'as BE usage nelaužo integrity.ok", async () => {
  const files = cleanFiles();
  files[abs("vq/logs/task-events.jsonl")] = `${EVENT_LINES}\n${JSON.stringify({
    task_id: "X-99",
    to_state: "dispatched",
    reason: "",
  })}\n`;
  const report = await captureBenchmarkReport(fakeFs(files), OPTIONS);
  assert.equal(report.integrity.malformed_event_lines, 0);
  assert.deepEqual(report.integrity.unassigned_task_ids, ["X-99"]);
  assert.equal(report.integrity.unassigned_usage_records, 0);
  assert.equal(report.integrity.unassigned_total_tokens, 0);
  assert.equal(report.integrity.ok, true);
});

test("sugadinta usage eilutė yra klaida — benchmark'as yra integrity kelias", async () => {
  const files = cleanFiles();
  files[abs("vq/logs/token-usage.jsonl")] = `${USAGE_LINES}\n{"task_id":"T-10"}\n`;
  await assert.rejects(
    () => captureBenchmarkReport(fakeFs(files), OPTIONS),
    /phase, task_id, and model are required/,
  );
});

test("markdown round-trip: parse(render(report)) grąžina identišką raportą", async () => {
  const report = await captureBenchmarkReport(fakeFs(cleanFiles()), OPTIONS);
  const markdown = renderBenchmarkReportMarkdown(report);
  assert.deepEqual(parseBenchmarkReportMarkdown(markdown), report);
  assert.match(renderBenchmarkReportText(report), /tokens_per_verified_accepted_change: 600 \[computed\]/);
  assert.throws(() => parseBenchmarkReportMarkdown("# be markerio"), /marker not found/);
});

test("markdown round-trip: nepriskirto task'o usage laukai išgyvena render/parse be pakeitimų", async () => {
  const files = cleanFiles();
  files[abs("vq/logs/token-usage.jsonl")] = `${USAGE_LINES}\n${JSON.stringify({
    phase: "dispatch",
    task_id: "X-99",
    model: "claude-sonnet-5",
    input_tokens: 30,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: 0.03,
  })}\n`;
  const report = await captureBenchmarkReport(fakeFs(files), OPTIONS);
  assert.equal(report.integrity.unassigned_usage_records, 1);
  assert.equal(report.integrity.unassigned_total_tokens, 50);
  const markdown = renderBenchmarkReportMarkdown(report);
  assert.match(markdown, /- unassigned_usage_records: 1/);
  assert.match(markdown, /- unassigned_total_tokens: 50/);
  assert.deepEqual(parseBenchmarkReportMarkdown(markdown), report);
});

test("senas markdown be unassigned usage laukų JSON bloke parsinamas su default 0", async () => {
  const report = await captureBenchmarkReport(fakeFs(cleanFiles()), OPTIONS);
  const legacyReport: Record<string, unknown> = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  const legacyIntegrity = legacyReport["integrity"] as Record<string, unknown>;
  delete legacyIntegrity["unassigned_usage_records"];
  delete legacyIntegrity["unassigned_total_tokens"];

  const markdown = [
    "# AG Loop optimization benchmark baseline",
    "",
    "<!-- ag:optimization-benchmark:v1 -->",
    "",
    "```json",
    JSON.stringify(legacyReport, null, 2),
    "```",
    "",
  ].join("\n");

  const parsed = parseBenchmarkReportMarkdown(markdown);
  assert.equal(parsed.integrity.unassigned_usage_records, 0);
  assert.equal(parsed.integrity.unassigned_total_tokens, 0);
});

test("compareWithBaseline: identiškas run'as prieš išsaugotą baseline yra palyginamas su nulinėmis deltomis", async () => {
  const fs = fakeFs(cleanFiles());
  const report = await captureBenchmarkReport(fs, OPTIONS);
  await writeBenchmarkBaseline(fs, report, PATHS.baselinePath);

  const comparison = await compareWithBaseline(fs, OPTIONS);
  assert.equal(comparison.baseline_ref.config_hash, report.config_hash);
  assert.equal(comparison.comparison.comparable, true);
  assert.equal(comparison.comparison.token_delta_pct, 0);
  assert.equal(comparison.comparison.accepted_change_delta, 0);
  assert.equal(comparison.case_comparisons.length, 1);
  assert.equal(comparison.case_comparisons[0]!.delta_pct, 0);
  assert.equal(typeof comparison.success_declaration.reason, "string");
});
