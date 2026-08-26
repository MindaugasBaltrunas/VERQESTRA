import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BENCHMARK_REPORT_FORMATS } from "../application/benchmark-api.js";
import { renderBenchmarkReportJson } from "../application/report/benchmark-report-json.js";
import {
  MARKDOWN_REPORT_SECTIONS,
  renderBenchmarkReportMarkdown,
} from "../application/report/benchmark-report-markdown.js";
import {
  NO_BASELINE_REASON,
  REPORT_DECIMAL_PLACES,
  REPRODUCTION_BASELINE_PLACEHOLDER,
  UNMEASURED_TEXT,
  buildBenchmarkReportModel,
  canonicalReportNumber,
  formatReportNumber,
  type BenchmarkReportInput,
} from "../application/report/benchmark-report-model.js";
import {
  createBenchmarkReportCapability,
  renderAllBenchmarkReports,
  renderBenchmarkReport,
} from "../application/report/benchmark-report.js";
import { EXECUTION_MODES } from "../domain/result.js";
import type { BenchmarkComparison } from "../domain/verdict.js";
import {
  generateBenchmarkReport,
  runBenchmarkReportGeneration,
} from "../interfaces/report/benchmark-report-entrypoint.js";
import {
  BENCHMARK_REPORT_FILE_NAMES,
  writeBenchmarkReports,
} from "../interfaces/report/write-benchmark-report.js";
import { BenchmarkPathEscapeError } from "../infrastructure/benchmark-workspace-paths.js";
import {
  REPORT_CONFIG_HASH,
  REPORT_POLICY_HASH,
  REPORT_SUITE_HASH,
  baselineDocument,
  reportIdentity,
  runSummary,
  tokenSamples,
} from "./report-fixtures.js";

/**
 * BENCH-10: the JSON and Markdown reports are deterministic, traceable to their
 * inputs, free of sensitive values and never in disagreement with each other.
 */

const CURRENT_TOKENS = [100, 200, 301] as const;
const BASELINE_TOKENS = [90, 100, 110] as const;

function comparisonFixture(overrides: Partial<BenchmarkComparison> = {}): BenchmarkComparison {
  return {
    verdict: "regressed",
    reasons: ["cost-increased"],
    scenarios: [
      {
        scenarioId: "bugfix-session-token-expiry",
        mode: "ag-loop",
        baseline: {
          count: 3,
          median: 100,
          mean: 100,
          min: 90,
          max: 110,
          standardDeviation: 8.164_965_809_277_26,
          successCount: 3,
        },
        current: {
          count: 3,
          median: 200,
          mean: 200.333_333_333_333_33,
          min: 100,
          max: 301,
          standardDeviation: 82.076_385_902_961_1,
          successCount: 3,
        },
        verdict: "regressed",
        reasons: ["cost-increased"],
      },
    ],
    limitations: ["a supplied limitation the report must forward unchanged"],
    ...overrides,
  };
}

function fullInput(overrides: Partial<BenchmarkReportInput> = {}): BenchmarkReportInput {
  return {
    summary: runSummary(tokenSamples([...CURRENT_TOKENS])),
    baseline: baselineDocument(tokenSamples([...BASELINE_TOKENS])),
    comparison: comparisonFixture(),
    ...overrides,
  };
}

/** Every table row of a Markdown document, split into trimmed cells. */
function markdownRows(markdown: string): readonly (readonly string[])[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .map((line) =>
      line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim()),
    );
}

function markdownRow(markdown: string, first: string): readonly string[] {
  const row = markdownRows(markdown).find((cells) => cells[0] === first);
  assert.ok(row !== undefined, `the Markdown report has no row starting with "${first}"`);
  return row;
}

// ---------------------------------------------------------------------------
// Canonical numbers
// ---------------------------------------------------------------------------

test("a report number is rounded once, and the same way for every format", () => {
  assert.equal(canonicalReportNumber(200.333_333_333_333_33), 200.3333);
  assert.equal(canonicalReportNumber(7), 7);
  // `-0` and `0` are the same measurement and must not render differently.
  assert.equal(Object.is(canonicalReportNumber(-0), 0), true);
  assert.equal(formatReportNumber(200.3333), "200.3333");
  assert.equal(formatReportNumber(7), "7");
  assert.equal(formatReportNumber(undefined), UNMEASURED_TEXT);
  assert.equal(REPORT_DECIMAL_PLACES, 4);
});

test("a non-finite number is refused rather than published as a measurement", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => canonicalReportNumber(value), TypeError);
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("both formats are byte-identical across renderings of the same inputs", () => {
  for (const format of BENCHMARK_REPORT_FORMATS) {
    const first = renderBenchmarkReport(format, fullInput());
    const second = renderBenchmarkReport(format, fullInput());
    assert.equal(first.content, second.content, `${format} is not deterministic`);
    assert.equal(first.format, format);
    assert.equal(first.generatedFrom.suiteHash, REPORT_SUITE_HASH);
  }
});

test("no report carries a generation timestamp, which nothing about the inputs fixes", () => {
  const { documents } = renderAllBenchmarkReports(fullInput());
  for (const document of documents) {
    assert.doesNotMatch(
      document.content,
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
      `${document.format} carries a timestamp`,
    );
  }
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

test("the verdict is the comparison's and is never recomputed by the report", () => {
  for (const verdict of ["improved", "stable", "regressed", "inconclusive"] as const) {
    const model = buildBenchmarkReportModel(
      fullInput({ comparison: comparisonFixture({ verdict }) }),
    );
    assert.equal(model.verdict, verdict);
    assert.equal(model.verdictBasis, "comparison");
  }
});

test("a report without a baseline is inconclusive by construction and says so", () => {
  const model = buildBenchmarkReportModel({ summary: runSummary(tokenSamples([...CURRENT_TOKENS])) });
  assert.equal(model.verdict, "inconclusive");
  assert.equal(model.verdictBasis, "no-baseline");
  assert.deepEqual(model.reasons, [NO_BASELINE_REASON]);
  assert.equal(model.baseline, undefined);
  assert.ok(
    model.limitations.some((limitation) => limitation.includes("no baseline comparison was supplied")),
  );
});

// ---------------------------------------------------------------------------
// Content the specification requires
// ---------------------------------------------------------------------------

test("the report states the verdict, both runs, the modes, the scenarios and the limitations", () => {
  const model = buildBenchmarkReportModel(fullInput());

  assert.equal(model.current.identity.suiteHash, REPORT_SUITE_HASH);
  assert.equal(model.baseline?.identity.configHash, REPORT_CONFIG_HASH);
  assert.equal(model.current.identity.policyHash, REPORT_POLICY_HASH);
  assert.equal(model.current.sampleCount, CURRENT_TOKENS.length);
  assert.equal(model.baseline?.sampleCount, BASELINE_TOKENS.length);

  assert.deepEqual(
    model.scenarios.map((scenario) => [scenario.scenarioId, scenario.mode, scenario.verdict]),
    [["bugfix-session-token-expiry", "ag-loop", "regressed"]],
  );
  // Statistics are rounded but never dropped: BENCH-9 requires all six.
  assert.deepEqual(model.scenarios[0]?.current, {
    count: 3,
    median: 200,
    mean: 200.3333,
    min: 100,
    max: 301,
    standardDeviation: 82.0764,
    successCount: 3,
  });

  assert.equal(
    model.limitations[0],
    "a supplied limitation the report must forward unchanged",
    "a limitation the comparison disclosed must reach the report first and unchanged",
  );
  assert.ok(
    model.limitations.some((limitation) => limitation.includes("rounded to 4 decimal place(s)")),
    "every report discloses that its numbers are rounded",
  );
});

test("a mode section carries both sides and the differences BENCH-3 requires to be reported", () => {
  const model = buildBenchmarkReportModel(fullInput());
  const section = model.modes.find((entry) => entry.mode === "ag-loop");
  assert.ok(section !== undefined);
  assert.equal(section.baselineSampleCount, BASELINE_TOKENS.length);
  assert.equal(section.currentSampleCount, CURRENT_TOKENS.length);
  assert.ok(section.differences.length > 0, "the ag-loop mode declares differences from the plan");

  const tokens = section.metrics.find(
    (row) => row.metric === "perVerifiedAcceptedChange.billableTokens",
  );
  assert.ok(tokens !== undefined);
  assert.equal(tokens.baseline, 100);
  assert.equal(tokens.current, 200.3333);
  assert.equal(tokens.absoluteDelta, 100.3333);
  assert.equal(tokens.relativeDelta, 1.0033);
});

test("a delta is absent when either side was not measured, never computed from an absent value", () => {
  const model = buildBenchmarkReportModel(fullInput());
  const section = model.modes.find((entry) => entry.mode === "ag-loop");
  const architecture = section?.metrics.find((row) => row.metric === "architectureFailureRate");
  assert.ok(architecture !== undefined);
  // No sample carries an architecture check, so neither side has a rate.
  assert.equal(architecture.baseline, undefined);
  assert.equal(architecture.current, undefined);
  assert.equal(architecture.absoluteDelta, undefined);
  assert.equal(architecture.relativeDelta, undefined);
});

test("a run missing an identity hash is reported as unattributable rather than compared quietly", () => {
  const model = buildBenchmarkReportModel({
    summary: runSummary(
      tokenSamples([...CURRENT_TOKENS]),
      reportIdentity({ configHash: "", agCommit: "" }),
    ),
  });
  for (const field of ["configHash", "agCommit"]) {
    assert.ok(
      model.limitations.some(
        (limitation) => limitation.includes(field) && limitation.includes("current run"),
      ),
      `a missing ${field} is not reported as a limitation`,
    );
  }
});

test("inconclusive samples are disclosed as the lower bound they make the cost", () => {
  const samples = [
    ...tokenSamples([100, 200]),
    ...tokenSamples([300], {
      sampleId: "sample-0003",
      acceptance: { verdict: "inconclusive", reasons: ["evidence-missing"], agentClaimedDone: false },
    }),
  ];
  const model = buildBenchmarkReportModel({ summary: runSummary(samples) });
  assert.ok(
    model.limitations.some(
      (limitation) => limitation.includes("inconclusive") && limitation.includes("lower bound"),
    ),
  );
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("modes and metrics follow the declared order, not the order samples arrived", () => {
  const samples = [
    ...tokenSamples([100], { sampleId: "s-control", mode: "deterministic-control" }),
    ...tokenSamples([200], { sampleId: "s-solo", mode: "agent-solo" }),
    ...tokenSamples([300], { sampleId: "s-loop", mode: "ag-loop" }),
  ];
  const model = buildBenchmarkReportModel({ summary: runSummary(samples) });

  assert.deepEqual(
    model.modes.map((section) => section.mode),
    [...EXECUTION_MODES],
  );
  assert.deepEqual(
    model.current.modes,
    [...EXECUTION_MODES],
    "the modes a run recorded are listed in declared order",
  );
  const metrics = model.modes[0]?.metrics.map((row) => row.metric) ?? [];
  assert.equal(metrics[0], "acceptedRate", "the rate metrics come first, in their declared order");
  assert.equal(metrics.at(-1), "perVerifiedAcceptedChange.llmCalls");
  assert.equal(new Set(metrics).size, metrics.length, "no metric is reported twice");
});

test("JSON object keys are sorted, so two reports differ only where the measurement differs", () => {
  const json = renderBenchmarkReportJson(buildBenchmarkReportModel(fullInput()));
  const topLevel = [...json.matchAll(/^ {2}"([a-zA-Z]+)":/gm)].map((match) => match[1] as string);
  assert.deepEqual(topLevel, [...topLevel].sort());
});

// ---------------------------------------------------------------------------
// The two formats agree
// ---------------------------------------------------------------------------

/** The part of the JSON document this test reads back. */
interface JsonMetricRow {
  readonly metric: string;
  readonly baseline?: number;
  readonly current?: number;
}

interface JsonModeSection {
  readonly mode: string;
  readonly metrics: readonly JsonMetricRow[];
}

test("every metric reads the same in both formats, with one spelling for `not measured`", () => {
  const model = buildBenchmarkReportModel(fullInput());
  const json = JSON.parse(renderBenchmarkReportJson(model)) as {
    readonly modes: readonly JsonModeSection[];
  };
  const markdown = renderBenchmarkReportMarkdown(model);

  assert.deepEqual(
    json.modes.map((section) => section.mode),
    model.modes.map((section) => section.mode),
  );

  for (const section of model.modes) {
    const jsonSection: JsonModeSection | undefined = json.modes.find(
      (entry) => entry.mode === section.mode,
    );
    assert.ok(jsonSection !== undefined);
    for (const row of section.metrics) {
      const jsonRow: JsonMetricRow | undefined = jsonSection.metrics.find(
        (entry) => entry.metric === row.metric,
      );
      assert.ok(jsonRow !== undefined, `${row.metric} is missing from the JSON report`);
      // An unmeasured value is an absent key in JSON and `n/a` in Markdown: one
      // fact, spelled in the vocabulary each format has for it.
      assert.equal(
        Object.hasOwn(jsonRow, "current"),
        row.current !== undefined,
        `${row.metric} disagrees between the model and the JSON report`,
      );
      const cells = markdownRow(markdown, row.metric);
      assert.equal(cells[2], formatReportNumber(row.baseline), `${row.metric} baseline`);
      assert.equal(cells[3], formatReportNumber(row.current), `${row.metric} current`);
    }
  }
});

test("the Markdown report carries every declared section, in order", () => {
  const markdown = renderBenchmarkReportMarkdown(buildBenchmarkReportModel(fullInput()));
  const headings = markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
  assert.deepEqual(headings, [...MARKDOWN_REPORT_SECTIONS]);
});

test("the verdict, the reasons, the scenarios and the limitations appear in both formats", () => {
  const model = buildBenchmarkReportModel(fullInput());
  const json = renderBenchmarkReportJson(model);
  const markdown = renderBenchmarkReportMarkdown(model);

  for (const content of [json, markdown]) {
    assert.ok(content.includes(model.verdict));
    for (const reason of model.reasons) assert.ok(content.includes(reason), `missing reason ${reason}`);
    for (const limitation of model.limitations) {
      assert.ok(content.includes(limitation), `missing limitation: ${limitation}`);
    }
    for (const scenario of model.scenarios) {
      assert.ok(content.includes(scenario.scenarioId), `missing scenario ${scenario.scenarioId}`);
    }
  }
});

test("the source hashes and the reproduction command appear in both formats", () => {
  const model = buildBenchmarkReportModel(fullInput());
  for (const document of renderAllBenchmarkReports(fullInput()).documents) {
    for (const hash of [REPORT_SUITE_HASH, REPORT_CONFIG_HASH, REPORT_POLICY_HASH]) {
      assert.ok(document.content.includes(hash), `${document.format} does not carry ${hash}`);
    }
    assert.ok(
      document.content.includes(model.reproduction.command),
      `${document.format} does not carry the reproduction command`,
    );
  }
  assert.equal(
    model.reproduction.command,
    `verqestra benchmark report --baseline ${REPRODUCTION_BASELINE_PLACEHOLDER}`,
  );
});

// ---------------------------------------------------------------------------
// Nothing sensitive
// ---------------------------------------------------------------------------

test("a credential in a reproduction argument is redacted, and no path is disclosed", () => {
  // Assembled at runtime rather than written out: a literal token shape in a
  // committed file is exactly what this repository's secret scan refuses, and a
  // test for redaction is no reason to make an exception for itself.
  const credential = ["sk", "ant", "abcdefghijklmnop"].join("-");
  const model = buildBenchmarkReportModel(
    fullInput({ reproductionArguments: [`--token=${credential}`] }),
  );
  assert.ok(!model.reproduction.command.includes(credential));
  assert.ok(model.reproduction.command.includes("[redacted]"));
  // The baseline is named by a placeholder, so a committed report cannot leak the
  // machine it was produced on.
  assert.ok(model.reproduction.command.includes(REPRODUCTION_BASELINE_PLACEHOLDER));
});

// ---------------------------------------------------------------------------
// The published API shape
// ---------------------------------------------------------------------------

test("the report capability satisfies the application API and renders the same content", async () => {
  const report = createBenchmarkReportCapability();
  const input = fullInput();
  const comparison = input.comparison;
  assert.ok(comparison !== undefined);

  const viaApi = await report({ format: "markdown", summary: input.summary, comparison });
  const direct = renderBenchmarkReport("markdown", { summary: input.summary, comparison });
  assert.equal(viaApi.content, direct.content);
  assert.equal(viaApi.format, "markdown");
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test("both formats are written into the reports directory from one model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ag-benchmark-report-"));
  try {
    const result = await writeBenchmarkReports(fullInput(), { packageRoot: root });
    assert.deepEqual(
      result.written.map((entry) => entry.format),
      [...BENCHMARK_REPORT_FORMATS],
    );
    for (const written of result.written) {
      const onDisk = await readFile(written.absolutePath, "utf8");
      const document = result.rendered.documents.find((entry) => entry.format === written.format);
      assert.equal(onDisk, document?.content);
      assert.equal(written.relativePath, `reports/${BENCHMARK_REPORT_FILE_NAMES[written.format]}`);
      assert.ok(!path.isAbsolute(written.relativePath));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a report directory outside the workspace is refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ag-benchmark-report-"));
  try {
    await assert.rejects(
      writeBenchmarkReports(fullInput(), { packageRoot: root, directory: "../escaped" }),
      BenchmarkPathEscapeError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("`benchmark:report` over an empty workspace reports nothing measured, not a clean run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ag-benchmark-report-"));
  const lines: string[] = [];
  try {
    const code = await runBenchmarkReportGeneration({ packageRoot: root, out: (line) => lines.push(line) });
    assert.equal(code, 0, "generating a report is not a gate and does not fail on its own verdict");

    const json = JSON.parse(
      await readFile(path.join(root, "reports", BENCHMARK_REPORT_FILE_NAMES.json), "utf8"),
    ) as { verdict: string; verdictBasis: string; limitations: readonly string[] };
    assert.equal(json.verdict, "inconclusive");
    assert.equal(json.verdictBasis, "no-baseline");
    assert.ok(
      json.limitations.some((limitation) => limitation.includes("holds no record")),
      "an empty ledger is disclosed rather than read as a run that measured nothing wrong",
    );
    assert.ok(
      json.limitations.some((limitation) => limitation.includes("did not validate")),
      "a suite that could not be read is disclosed",
    );
    assert.ok(lines.some((line) => line.includes("inconclusive")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The real-workspace run of `benchmark:report`.
 *
 * Deliberately not hermetic: it reads this package's authored suite and its
 * actual sample ledger and writes the two files the script writes. That is the
 * point — every other test here drives the generator against a fixture, and none
 * of them would notice a suite this package cannot load or a ledger it cannot
 * read. The only files touched are the generated reports, which the entry point
 * owns and `reports/.gitignore` keeps out of the history.
 */
test("`benchmark:report` runs against this package's own suite and ledger", async () => {
  const result = await generateBenchmarkReport({ out: () => undefined });
  const model = result.rendered.model;

  assert.deepEqual(
    result.written.map((entry) => entry.relativePath),
    BENCHMARK_REPORT_FORMATS.map((format) => `reports/${BENCHMARK_REPORT_FILE_NAMES[format]}`),
  );
  for (const written of result.written) {
    const onDisk = await readFile(written.absolutePath, "utf8");
    assert.equal(
      onDisk,
      result.rendered.documents.find((entry) => entry.format === written.format)?.content,
    );
  }

  // Either the suite is identified, or the report says why it is not. A third
  // outcome — a report with no hash and no explanation — is what BENCH-8 forbids.
  assert.ok(
    model.current.identity.suiteHash !== "" ||
      model.limitations.some((limitation) => limitation.includes("suiteHash")),
    "a report without a suite hash must disclose that it has none",
  );
  // 2026-08-26: generatorius pats atranda naujausią užantspauduotą baseline'ą (`baselines/`)
  // ir įdeda palyginimą — iki tol dashboard'o „palyginimas su baseline" likdavo amžinai
  // tuščias. Testas bėga prieš REALŲ repo, tad baseline'o buvimas yra aplinkos faktas —
  // pin'inamas ne konkretus basis, o invariantas: kad ir kuris basis, raportas jį pagrindžia.
  if (model.verdictBasis === "comparison") {
    assert.ok(model.baseline !== undefined, "comparison basis privalo atsinešti baseline faktus");
  } else {
    assert.equal(model.verdictBasis, "no-baseline");
    assert.ok(
      model.reasons.includes("no-baseline-comparison") ||
        model.limitations.some((limitation) => limitation.includes("baseline")),
      "no-baseline basis privalo būti deklaruotas priežastimi arba limitation eilute",
    );
  }
});
