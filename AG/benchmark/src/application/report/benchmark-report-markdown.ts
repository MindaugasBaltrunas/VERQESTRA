import type { DistributionStatistics } from "../../domain/verdict.js";
import {
  UNMEASURED_TEXT,
  formatReportNumber,
  type BenchmarkReportModel,
  type ReportCompressionCombination,
  type ReportIdentity,
  type ReportModeSection,
  type ReportRunFacts,
  type ReportScenarioSection,
} from "./benchmark-report-model.js";

/**
 * The Markdown rendering of a report (BENCH-10).
 *
 * The same {@link BenchmarkReportModel} the JSON rendering serialises, laid out
 * for a reader. It formats and it does nothing else: no number is computed here,
 * no verdict is decided here, and no fact appears here that the model does not
 * carry. That is what makes "the two formats agree" checkable rather than
 * asserted — the only way they could disagree is a formatting bug, and a test can
 * hold the rendered text against the model field by field.
 *
 * Numbers go through the shared {@link formatReportNumber}, so a rate reads the
 * same here as in the JSON document, and an unmeasured value reads
 * `{@link UNMEASURED_TEXT}` where the JSON simply has no key — the same fact in
 * the vocabulary each format has for it.
 */

/** Every section this document has, in order. Exported so a test can state the contract rather than a regex. */
export const MARKDOWN_REPORT_SECTIONS = [
  "Verdict",
  "Runs",
  "Modes",
  "Scenarios",
  "Compression",
  "Limitations",
  "Sources",
] as const;

const TITLE = "Benchmark report";

/**
 * A table cell may not contain the character that separates cells, nor a line
 * break. Both are escaped rather than dropped: a limitation or a reason code is
 * evidence, and silently losing part of it is the failure this whole layer exists
 * to prevent.
 */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function code(text: string): string {
  return text === "" ? UNMEASURED_TEXT : `\`${text}\``;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): readonly string[] {
  return [
    `| ${header.map(cell).join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
}

function bullets(items: readonly string[], empty: string): readonly string[] {
  return items.length === 0 ? [empty] : items.map((item) => `- ${item}`);
}

function optionalCount(count: number | undefined): string {
  return count === undefined ? UNMEASURED_TEXT : String(count);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function verdictSection(model: BenchmarkReportModel): readonly string[] {
  return [
    "## Verdict",
    "",
    `- Verdict: ${code(model.verdict)}`,
    `- Basis: ${code(model.verdictBasis)}`,
    "- Reasons:",
    ...model.reasons.map((reason) => `  - ${code(reason)}`),
    ...(model.reasons.length === 0 ? ["  - (none stated)"] : []),
  ];
}

function environmentRows(
  baseline: ReportRunFacts | undefined,
  current: ReportRunFacts,
): readonly (readonly string[])[] {
  const side = (facts: ReportRunFacts | undefined, read: (facts: ReportRunFacts) => string): string =>
    facts === undefined ? UNMEASURED_TEXT : read(facts);
  const rows: readonly [string, (facts: ReportRunFacts) => string][] = [
    ["platform", (facts) => facts.environment.platform],
    ["arch", (facts) => facts.environment.arch],
    ["nodeVersion", (facts) => facts.environment.nodeVersion],
    ["cpuCount", (facts) => String(facts.environment.cpuCount)],
    ["samples", (facts) => String(facts.sampleCount)],
    ["modes", (facts) => (facts.modes.length === 0 ? UNMEASURED_TEXT : facts.modes.join(", "))],
  ];
  return rows.map(([field, read]) => [field, side(baseline, read), read(current)]);
}

function runsSection(model: BenchmarkReportModel): readonly string[] {
  return [
    "## Runs",
    "",
    ...table(["field", "baseline", "current"], environmentRows(model.baseline, model.current)),
  ];
}

function modeSection(section: ReportModeSection): readonly string[] {
  return [
    `### ${section.mode}`,
    "",
    `Samples: baseline ${optionalCount(section.baselineSampleCount)}, current ${optionalCount(section.currentSampleCount)}`,
    "",
    ...table(
      ["metric", "kind", "baseline", "current", "delta", "relative delta"],
      section.metrics.map((row) => [
        row.metric,
        row.kind,
        formatReportNumber(row.baseline),
        formatReportNumber(row.current),
        formatReportNumber(row.absoluteDelta),
        formatReportNumber(row.relativeDelta),
      ]),
    ),
    "",
    "Declared differences from the common execution plan (BENCH-3):",
    "",
    ...bullets(
      section.differences.map(
        (difference) => `${code(difference.aspect)} ${code(difference.code)}: ${difference.detail}`,
      ),
      "- (none declared)",
    ),
  ];
}

function modesSection(model: BenchmarkReportModel): readonly string[] {
  if (model.modes.length === 0) {
    return ["## Modes", "", "No execution mode recorded a sample on either side."];
  }
  return ["## Modes", "", ...model.modes.flatMap((section) => [...modeSection(section), ""]).slice(0, -1)];
}

function statisticsRow(side: string, statistics: DistributionStatistics): readonly string[] {
  return [
    side,
    String(statistics.count),
    formatReportNumber(statistics.median),
    formatReportNumber(statistics.mean),
    formatReportNumber(statistics.min),
    formatReportNumber(statistics.max),
    formatReportNumber(statistics.standardDeviation),
    String(statistics.successCount),
  ];
}

function scenarioSection(section: ReportScenarioSection): readonly string[] {
  return [
    `### ${section.scenarioId} (${section.mode})`,
    "",
    `- Verdict: ${code(section.verdict)}`,
    `- Reasons: ${section.reasons.length === 0 ? "(none stated)" : section.reasons.map(code).join(", ")}`,
    "",
    ...table(
      ["side", "count", "median", "mean", "min", "max", "stdDev", "verified accepted"],
      [statisticsRow("baseline", section.baseline), statisticsRow("current", section.current)],
    ),
  ];
}

function scenariosSection(model: BenchmarkReportModel): readonly string[] {
  if (model.scenarios.length === 0) {
    return ["## Scenarios", "", "No scenario had statistics on both sides, so none was compared."];
  }
  return [
    "## Scenarios",
    "",
    ...model.scenarios.flatMap((section) => [...scenarioSection(section), ""]).slice(0, -1),
  ];
}

/**
 * The compression cohort (task 0029).
 *
 * One row per declared variant, in the cohort's own order, so a variant nobody
 * ran is visibly present and `n/a` rather than quietly missing. The character
 * counters get their own table and only when something was actually counted:
 * seven columns of `n/a` per variant would bury the verdicts under diagnostics
 * that decide nothing anyway.
 */
function compressionSection(model: BenchmarkReportModel): readonly string[] {
  const section = model.compression;
  if (section === undefined) {
    return [
      "## Compression",
      "",
      "No compression cohort was summarised for this report.",
    ];
  }

  const diagnosticRows = section.variants.flatMap((variant) =>
    variant.diagnostics
      .filter((row) => row.baseline !== undefined || row.current !== undefined)
      .map((row) => [
        variant.variantId,
        row.metric,
        formatReportNumber(row.baseline),
        formatReportNumber(row.current),
        formatReportNumber(row.absoluteDelta),
      ]),
  );

  return [
    "## Compression",
    "",
    `- Registry version: ${code(String(section.registryVersion))}`,
    `- Cost KPI version: ${code(String(section.costKpiVersion))} (primary KPI: billable tokens per verified-accepted task)`,
    `- Baseline variant: ${code(section.baselineVariantId)}`,
    `- Samples belonging to no declared variant: ${section.unattributedSampleCount}`,
    "",
    ...table(
      [
        "variant",
        "features",
        "hooks",
        "samples",
        "conclusive",
        "captured usage",
        "verdict",
        "billable tokens/accepted task",
        "billable delta (variant − baseline)",
        "billable relative delta",
        "raw tokens/accepted task (safety)",
        "raw delta (variant − baseline)",
        "raw relative delta",
        "accepted",
        "security failures",
        "out of scope",
        "repairs/task",
        "human reviews/task",
        "reasons",
      ],
      section.variants.map((variant) => [
        variant.variantId,
        variant.features.length === 0 ? "(none)" : variant.features.join(", "),
        variant.hookProfile,
        String(variant.sampleCount),
        String(variant.conclusiveCount),
        String(variant.capturedUsageCount),
        variant.verdict,
        formatReportNumber(variant.billableTokensPerAcceptedTask),
        formatReportNumber(variant.billableTokensPerAcceptedTaskDelta),
        formatReportNumber(variant.billableTokensPerAcceptedTaskRelativeDelta),
        formatReportNumber(variant.rawTokensPerAcceptedTask),
        formatReportNumber(variant.rawTokensPerAcceptedTaskDelta),
        formatReportNumber(variant.rawTokensPerAcceptedTaskRelativeDelta),
        formatReportNumber(variant.acceptedRate),
        formatReportNumber(variant.securityFailureRate),
        formatReportNumber(variant.outOfScopeRate),
        formatReportNumber(variant.repairsPerTask),
        formatReportNumber(variant.humanReviewEventsPerTask),
        variant.reasons.length === 0 ? "(none stated)" : variant.reasons.join(", "),
      ]),
    ),
    "",
    "Token totals per conclusive sample (the components both KPIs are built from):",
    "",
    ...table(
      [
        "variant",
        "raw total",
        "billable",
        "non-cached",
        "cache read",
        "cache creation",
        "turns/task",
      ],
      section.variants.map((variant) => [
        variant.variantId,
        formatReportNumber(variant.usage.totalTokens),
        formatReportNumber(variant.usage.billableTokens),
        formatReportNumber(variant.usage.nonCachedTokens),
        formatReportNumber(variant.usage.cacheReadTokens),
        formatReportNumber(variant.usage.cacheCreationTokens),
        formatReportNumber(variant.usage.turnsPerTask),
      ]),
    ),
    "",
    ...combinationLines(section.combination),
    "",
    "Diagnostics (character counters; they decide no verdict):",
    "",
    ...(diagnosticRows.length === 0
      ? ["- (no compression diagnostic was recorded)"]
      : table(["variant", "counter", "baseline", "current", "delta"], diagnosticRows)),
    "",
    "Limitations of this section:",
    "",
    ...bullets(section.limitations, "- (none stated)"),
  ];
}

/** Contributions are stated as savings — `baseline − variant` — so a positive number is a saving. */
function combinationLines(
  combination: ReportCompressionCombination | undefined,
): readonly string[] {
  if (combination === undefined) {
    return ["The cohort declares no full combination, so no interaction can be stated."];
  }
  return [
    `Per-feature contribution to billable tokens per accepted task, against \`${combination.variantId}\` (baseline − variant; positive is a saving):`,
    "",
    ...table(
      ["feature", "measured on", "contribution", "relative"],
      combination.featureContributions.map((entry) => [
        entry.feature,
        entry.variantId === "" ? UNMEASURED_TEXT : entry.variantId,
        formatReportNumber(entry.contribution),
        formatReportNumber(entry.relativeContribution),
      ]),
    ),
    "",
    `- Sum of the measured single-feature contributions: ${formatReportNumber(combination.sumOfSingleFeatureContributions)}`,
    `- Observed contribution of the combination: ${formatReportNumber(combination.observedCombinationContribution)}`,
    `- Interaction residual (observed − sum): ${formatReportNumber(combination.interactionResidual)}`,
  ];
}

function limitationsSection(model: BenchmarkReportModel): readonly string[] {
  return ["## Limitations", "", ...bullets(model.limitations, "- (none stated)")];
}

function identityRows(
  baseline: ReportIdentity | undefined,
  current: ReportIdentity,
): readonly (readonly string[])[] {
  const hashRows = (["suiteHash", "configHash", "policyHash", "agCommit"] as const).map((field) => [
    field,
    baseline === undefined ? UNMEASURED_TEXT : code(baseline[field]),
    code(current[field]),
  ]);
  // Looked up by mode rather than by position: both sides are built in declared
  // mode order today, and a row that silently pairs two different modes is the
  // kind of mistake a report is read for months without anyone noticing.
  const adapterRows = current.modeAdapterVersions.map((entry) => [
    `adapter ${entry.mode}`,
    baseline === undefined
      ? UNMEASURED_TEXT
      : code(baseline.modeAdapterVersions.find((side) => side.mode === entry.mode)?.version ?? ""),
    code(entry.version),
  ]);
  return [...hashRows, ...adapterRows];
}

function sourcesSection(model: BenchmarkReportModel): readonly string[] {
  return [
    "## Sources",
    "",
    ...table(
      ["source", "baseline", "current"],
      identityRows(model.baseline?.identity, model.current.identity),
    ),
    "",
    `Reproduce: \`${cell(model.reproduction.command)}\``,
  ];
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** The Markdown report document. Ends with a newline, as a text file does. */
export function renderBenchmarkReportMarkdown(model: BenchmarkReportModel): string {
  const lines = [
    `# ${TITLE}`,
    "",
    ...verdictSection(model),
    "",
    ...runsSection(model),
    "",
    ...modesSection(model),
    "",
    ...scenariosSection(model),
    "",
    ...compressionSection(model),
    "",
    ...limitationsSection(model),
    "",
    ...sourcesSection(model),
  ];
  return `${lines.join("\n")}\n`;
}
