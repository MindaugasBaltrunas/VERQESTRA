import assert from "node:assert/strict";
import test from "node:test";

import { renderBenchmarkReportJson } from "../application/report/benchmark-report-json.js";
import {
  MARKDOWN_REPORT_SECTIONS,
  renderBenchmarkReportMarkdown,
} from "../application/report/benchmark-report-markdown.js";
import {
  UNMEASURED_TEXT,
  buildBenchmarkReportModel,
} from "../application/report/benchmark-report-model.js";
import {
  summarizeCompressionCohort,
  type ReportCompressionSection,
} from "../application/report/compression-report-section.js";
import { COMPRESSION_COST_KPI_VERSION } from "../domain/compression/aggregate.js";
import { COMPRESSION_COHORT, baselineVariant, variantById } from "../domain/compression/cohort.js";
import { CONTEXT_COMPRESSION_REGISTRY_VERSION } from "../domain/compression/features.js";
import type { CompressionVariant } from "../domain/compression/variant.js";
import type { BenchmarkSample } from "../domain/result.js";
import { generateBenchmarkReport } from "../interfaces/report/benchmark-report-entrypoint.js";
import { compressionSample } from "./compression-fixtures.js";
import { runSummary } from "./report-fixtures.js";
import { validSample } from "./sample-fixtures.js";

/**
 * The compression section of a report (task 0029, BENCH-10).
 *
 * The honesty guard is the point of this file: with nothing recorded, the report
 * must say so in both formats and must not contain a token figure anywhere. The
 * rest asserts that what the section does publish is attributable — a
 * contribution to the variant it was measured on, a residual to no feature at
 * all, and the same verdict in the JSON as in the Markdown.
 */

const BASELINE = baselineVariant();
/** Every key a token figure could be published under; none may appear with nothing recorded. */
const KPI_KEYS = ["billableTokensPerAcceptedTask", "rawTokensPerAcceptedTask"] as const;

function assertNoKpiKey(json: string, message: string): void {
  for (const key of KPI_KEYS) assert.ok(!json.includes(key), `${message}: ${key}`);
}

function modelWith(section: ReportCompressionSection, samples: readonly BenchmarkSample[] = []) {
  return buildBenchmarkReportModel({ summary: runSummary(samples), compression: section });
}

function variantOf(id: string): CompressionVariant {
  const variant = variantById(id);
  assert.ok(variant !== undefined, `the cohort declares no "${id}" variant`);
  return variant;
}

/** Three accepted samples of one variant, each costing `tokens`, with a decided security gate. */
function runs(variant: CompressionVariant, tokens: number): readonly BenchmarkSample[] {
  return Array.from({ length: 3 }, () =>
    compressionSample({ variant, tokens, securityCheck: "passed" }),
  );
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

/** The `## Compression` section's text, so an assertion cannot pass on another section's words. */
function compressionText(markdown: string): string {
  const start = markdown.indexOf("## Compression");
  const end = markdown.indexOf("## Limitations");
  assert.ok(start >= 0 && end > start, "the Markdown report has no Compression section");
  return markdown.slice(start, end);
}

// ---------------------------------------------------------------------------
// The honesty guard
// ---------------------------------------------------------------------------

test("an empty ledger leaves every variant not measured", () => {
  const section = summarizeCompressionCohort([]);

  assert.equal(section.registryVersion, CONTEXT_COMPRESSION_REGISTRY_VERSION);
  assert.equal(section.baselineVariantId, BASELINE.id);
  assert.deepEqual(
    section.variants.map((variant) => variant.variantId),
    COMPRESSION_COHORT.map((variant) => variant.id),
  );
  for (const variant of section.variants) {
    assert.equal(variant.verdict, "not_measured", variant.variantId);
    assert.equal(variant.sampleCount, 0);
    assert.equal(variant.capturedUsageCount, 0);
    assert.equal(variant.billableTokensPerAcceptedTask, undefined);
    assert.equal(variant.billableTokensPerAcceptedTaskDelta, undefined);
    assert.equal(variant.rawTokensPerAcceptedTask, undefined);
    assert.equal(variant.rawTokensPerAcceptedTaskDelta, undefined);
  }
  assert.equal(section.combination?.observedCombinationContribution, undefined);
  assert.equal(section.combination?.sumOfSingleFeatureContributions, undefined);
  assert.equal(section.combination?.interactionResidual, undefined);
});

test("with nothing recorded the JSON report carries no token figure at all", () => {
  const json = renderBenchmarkReportJson(modelWith(summarizeCompressionCohort([])));

  assert.ok(json.includes('"compression"'), "the section itself is present");
  assertNoKpiKey(
    json,
    "an unmeasured metric is an absent key; a present one would be read as a measurement",
  );
});

test("with nothing recorded the Markdown says so, in the compression section", () => {
  const markdown = renderBenchmarkReportMarkdown(modelWith(summarizeCompressionCohort([])));
  const section = compressionText(markdown);

  assert.ok(section.includes("no compression sample has been recorded"));
  assert.ok(section.includes("no compression claim may be made from this package"));
  assert.ok(section.includes(UNMEASURED_TEXT), "the numbers read as not measured, not as zero");
  for (const variant of COMPRESSION_COHORT) {
    assert.ok(section.includes(variant.id), `${variant.id} is missing from the section`);
  }
});

test("`benchmark:report` against this package's own ledger still measures no compression", async () => {
  const result = await generateBenchmarkReport({ out: () => undefined });
  const section = result.rendered.model.compression;

  assert.ok(section !== undefined, "the generator always summarises the cohort");
  for (const variant of section.variants) {
    assert.equal(variant.verdict, "not_measured", variant.variantId);
  }
  const json = result.rendered.documents.find((document) => document.format === "json")?.content;
  const markdown = result.rendered.documents.find(
    (document) => document.format === "markdown",
  )?.content;
  assertNoKpiKey(json ?? "", "the live ledger measures no compression");
  assert.ok(compressionText(markdown ?? "").includes("no compression sample has been recorded"));
});

// ---------------------------------------------------------------------------
// Document structure
// ---------------------------------------------------------------------------

test("the compression section is a declared Markdown section, in its declared place", () => {
  const markdown = renderBenchmarkReportMarkdown(modelWith(summarizeCompressionCohort([])));
  const headings = markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));

  assert.ok((MARKDOWN_REPORT_SECTIONS as readonly string[]).includes("Compression"));
  assert.deepEqual(headings, [...MARKDOWN_REPORT_SECTIONS]);
});

test("a report nobody summarised a cohort for says that, rather than showing an empty one", () => {
  const model = buildBenchmarkReportModel({ summary: runSummary([]) });
  assert.equal(model.compression, undefined);
  assert.ok(
    compressionText(renderBenchmarkReportMarkdown(model)).includes(
      "No compression cohort was summarised",
    ),
  );
});

// ---------------------------------------------------------------------------
// What a measured cohort publishes
// ---------------------------------------------------------------------------

test("a variant's verdict reads the same in both formats", () => {
  const samples = [
    ...runs(BASELINE, 1_000),
    ...runs(variantOf("worker-task-ir"), 400),
    ...runs(variantOf("compact-dsl"), 1_000),
  ];
  const section = summarizeCompressionCohort(samples);
  const model = modelWith(section, samples);
  const json = JSON.parse(renderBenchmarkReportJson(model)) as {
    compression: ReportCompressionSection;
  };
  const rows = markdownRows(renderBenchmarkReportMarkdown(model));

  for (const variant of json.compression.variants) {
    const row = rows.find((cells) => cells[0] === variant.variantId);
    assert.ok(row !== undefined, `the Markdown has no row for ${variant.variantId}`);
    assert.equal(row[6], variant.verdict, `${variant.variantId} verdict`);
  }
  assert.equal(
    json.compression.variants.find((variant) => variant.variantId === "worker-task-ir")?.verdict,
    "accepted",
  );
  assert.equal(
    json.compression.variants.find((variant) => variant.variantId === "compact-dsl")?.verdict,
    "rejected",
  );
});

test("the cost KPI version is published in both formats, with the incomparability it implies", () => {
  const section = summarizeCompressionCohort([]);
  const model = modelWith(section);
  const json = JSON.parse(renderBenchmarkReportJson(model)) as {
    compression: ReportCompressionSection;
  };

  assert.equal(section.costKpiVersion, COMPRESSION_COST_KPI_VERSION);
  assert.equal(json.compression.costKpiVersion, COMPRESSION_COST_KPI_VERSION);
  assert.ok(
    compressionText(renderBenchmarkReportMarkdown(model)).includes(
      `Cost KPI version: \`${COMPRESSION_COST_KPI_VERSION}\``,
    ),
    "a reader comparing two reports has to be able to see which quantity each measured",
  );
  assert.ok(
    section.limitations.some(
      (limitation) =>
        limitation.includes("earlier costKpiVersion") && limitation.includes("not comparable"),
    ),
    "baselines from the raw-total era are named as incomparable rather than silently subtracted",
  );
  assert.ok(
    section.limitations.some((limitation) => limitation.includes("safety bound, not as the objective")),
  );
});

test("a cache-shifted variant is reported as accepted, with both KPIs beside each other", () => {
  const variant = variantOf("worker-task-ir");
  const samples = [
    ...runs(BASELINE, 1_000),
    ...Array.from({ length: 3 }, () =>
      compressionSample({
        variant,
        tokens: 800,
        cacheReadInputTokens: 300,
        securityCheck: "passed",
      }),
    ),
  ];
  const row = summarizeCompressionCohort(samples).variants.find(
    (entry) => entry.variantId === variant.id,
  );

  assert.equal(row?.verdict, "accepted");
  assert.equal(row?.billableTokensPerAcceptedTask, 800);
  assert.equal(row?.billableTokensPerAcceptedTaskDelta, -200);
  assert.equal(row?.rawTokensPerAcceptedTask, 1_100, "the safety KPI is published, not hidden");
  assert.equal(row?.rawTokensPerAcceptedTaskDelta, 100);
});

test("all four telemetry components reach the rendered report, in both formats", () => {
  const variant = variantOf("worker-task-ir");
  const samples = [
    ...runs(BASELINE, 1_000),
    ...Array.from({ length: 3 }, () =>
      compressionSample({
        variant,
        tokens: 700,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 40,
        numTurns: 9,
        securityCheck: "passed",
      }),
    ),
  ];
  const section = summarizeCompressionCohort(samples);
  const model = modelWith(section, samples);
  const json = JSON.parse(renderBenchmarkReportJson(model)) as {
    compression: ReportCompressionSection;
  };
  const row = json.compression.variants.find((entry) => entry.variantId === variant.id);

  // Demoting the raw stream to a safety bound must not make the counters behind
  // it invisible: without these a reader cannot tell a shrunk prompt from a
  // prompt that moved into the cache.
  assert.deepEqual(row?.usage, {
    totalTokens: 1_040,
    billableTokens: 740,
    nonCachedTokens: 700,
    cacheReadTokens: 300,
    cacheCreationTokens: 40,
    turnsPerTask: 9,
  });

  const markdown = compressionText(renderBenchmarkReportMarkdown(model));
  assert.ok(markdown.includes("Token totals per conclusive sample"));
  for (const heading of ["raw total", "billable", "non-cached", "cache read", "cache creation"]) {
    assert.ok(markdown.includes(heading), `the Markdown token totals table lacks "${heading}"`);
  }
  const totalsRow = markdownRows(renderBenchmarkReportMarkdown(model))
    .filter((cells) => cells[0] === variant.id)
    .find((cells) => cells[1] === "1040");
  assert.ok(totalsRow !== undefined, "the Markdown publishes the raw total it was handed");
  assert.deepEqual([...totalsRow.slice(1, 6)], ["1040", "740", "700", "300", "40"]);
});

test("a contribution is shown against the variant it was measured on", () => {
  const symbolSlices = variantOf("symbol-slices");
  const samples = [...runs(BASELINE, 1_000), ...runs(symbolSlices, 600)];
  const combination = summarizeCompressionCohort(samples).combination;

  const contribution = combination?.featureContributions.find(
    (entry) => entry.feature === "symbol_slices",
  );
  assert.equal(contribution?.variantId, symbolSlices.id);
  assert.equal(contribution?.contribution, 400, "1000 - 600, stated as a saving");
  assert.equal(contribution?.relativeContribution, 0.4);
});

test("the Bash digest contribution is measured on the variant wired like the combination", () => {
  const combination = summarizeCompressionCohort([]).combination;
  const contribution = combination?.featureContributions.find(
    (entry) => entry.feature === "bash_output_digest",
  );

  assert.equal(
    contribution?.variantId,
    "bash-digest-handler",
    "the combination runs the handler, so the shadow variant is not the comparable one",
  );
});

test("a feature nobody ran on its own is not measured, and is never derived by subtraction", () => {
  const samples = [
    ...runs(BASELINE, 1_000),
    ...runs(variantOf("all-features"), 200),
    ...runs(variantOf("worker-task-ir"), 900),
  ];
  const combination = summarizeCompressionCohort(samples).combination;

  assert.equal(combination?.observedCombinationContribution, 800);
  const unrun = combination?.featureContributions.find(
    (entry) => entry.feature === "symbol_slices",
  );
  assert.equal(unrun?.contribution, undefined);
  assert.equal(
    combination?.interactionResidual,
    undefined,
    "a residual over a partial sum would attribute the gap to the features that were run",
  );
});

test("the residual is stated only once every single-feature variant has been run", () => {
  const singles = [
    ["worker_task_ir", "worker-task-ir"],
    ["compact_dsl", "compact-dsl"],
    ["symbol_slices", "symbol-slices"],
    ["bash_output_digest", "bash-digest-handler"],
    ["dispatch_tool_schema", "dispatch-tool-schema"],
  ] as const;
  const samples = [
    ...runs(BASELINE, 1_000),
    ...singles.flatMap(([, id]) => runs(variantOf(id), 900)),
    ...runs(variantOf("all-features"), 700),
  ];
  const combination = summarizeCompressionCohort(samples).combination;

  assert.equal(combination?.sumOfSingleFeatureContributions, 500, "five features saving 100 each");
  assert.equal(combination?.observedCombinationContribution, 300);
  assert.equal(
    combination?.interactionResidual,
    -200,
    "the combination saved less than its parts did apart, and that belongs to no feature",
  );
});

test("samples belonging to no declared variant are counted and named, never absorbed", () => {
  const samples = [...runs(BASELINE, 1_000), validSample({ sampleId: "unattributed-0001" })];
  const section = summarizeCompressionCohort(samples);

  assert.equal(section.unattributedSampleCount, 1);
  assert.equal(
    section.variants.find((variant) => variant.variantId === BASELINE.id)?.sampleCount,
    3,
    "the baseline is not the place unattributed runs are put",
  );
  assert.ok(
    section.limitations.some((limitation) => limitation.includes("no declared compression variant")),
  );
});

test("the character counters are published as diagnostics and labelled as such", () => {
  const samples = [
    ...runs(BASELINE, 1_000),
    compressionSample({
      variant: variantOf("compiled-prompt"),
      tokens: 900,
      securityCheck: "passed",
      diagnostics: { rawTaskChars: 8_000, compiledTaskChars: 2_000 },
    }),
  ];
  const section = summarizeCompressionCohort(samples);
  const row = section.variants.find((variant) => variant.variantId === "compiled-prompt");

  assert.equal(
    row?.diagnostics.find((diagnostic) => diagnostic.metric === "compiledTaskChars")?.current,
    2_000,
  );
  const markdown = compressionText(
    renderBenchmarkReportMarkdown(modelWith(section, samples)),
  );
  assert.ok(markdown.includes("they decide no verdict"));
  assert.ok(
    section.limitations.some((limitation) => limitation.includes("not how many tokens it saved")),
  );
});
