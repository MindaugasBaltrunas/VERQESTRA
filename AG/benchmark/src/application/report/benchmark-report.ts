import {
  BENCHMARK_REPORT_FORMATS,
  type BenchmarkApplicationApi,
  type BenchmarkReportDocument,
  type BenchmarkReportFormat,
  type BenchmarkReportRequest,
} from "../benchmark-api.js";
import { renderBenchmarkReportJson } from "./benchmark-report-json.js";
import { renderBenchmarkReportMarkdown } from "./benchmark-report-markdown.js";
import {
  buildBenchmarkReportModel,
  type BenchmarkReportInput,
  type BenchmarkReportModel,
} from "./benchmark-report-model.js";

/**
 * Report generation (BENCH-10).
 *
 * One model, two renderers, one entry point. A caller names a format and gets a
 * {@link BenchmarkReportDocument}; the facts in it were assembled once by
 * {@link buildBenchmarkReportModel} and neither renderer can add to them.
 *
 * The function is pure: same inputs, same bytes, no clock, no filesystem, no
 * network. Writing a document somewhere is the delivery layer's job
 * (`interfaces/report`), which is what keeps this testable by comparing two
 * strings.
 */

/** Both formats of one model, so a caller emitting a pair cannot build the facts twice. */
export interface RenderedBenchmarkReport {
  readonly model: BenchmarkReportModel;
  readonly documents: readonly BenchmarkReportDocument[];
}

/**
 * Unreachable while every declared format has a renderer. Typed `never`, so
 * adding a format without one is a compile error rather than an empty document.
 */
function unsupportedFormat(format: never): never {
  throw new RangeError(
    `"${String(format)}" is not a benchmark report format (${BENCHMARK_REPORT_FORMATS.join(", ")}).`,
  );
}

function renderContent(format: BenchmarkReportFormat, model: BenchmarkReportModel): string {
  switch (format) {
    case "json":
      return renderBenchmarkReportJson(model);
    case "markdown":
      return renderBenchmarkReportMarkdown(model);
    default:
      return unsupportedFormat(format);
  }
}

function documentOf(
  format: BenchmarkReportFormat,
  model: BenchmarkReportModel,
  request: BenchmarkReportInput,
): BenchmarkReportDocument {
  return {
    format,
    content: renderContent(format, model),
    // The identity of the run being reported, not of the baseline: a report is
    // evidence about the current run, and a reader tracing it back needs the
    // hashes of what was measured.
    generatedFrom: request.summary.identity,
  };
}

/** One report document in the named format. */
export function renderBenchmarkReport(
  format: BenchmarkReportFormat,
  input: BenchmarkReportInput,
): BenchmarkReportDocument {
  return documentOf(format, buildBenchmarkReportModel(input), input);
}

/**
 * Every format of one report.
 *
 * Both documents are rendered from a single model, so the JSON and the Markdown
 * artefact of one run cannot describe two different runs — the failure a pair of
 * separately built reports invites.
 */
export function renderAllBenchmarkReports(input: BenchmarkReportInput): RenderedBenchmarkReport {
  const model = buildBenchmarkReportModel(input);
  return {
    model,
    documents: BENCHMARK_REPORT_FORMATS.map((format) => documentOf(format, model, input)),
  };
}

/**
 * The `report` capability of {@link BenchmarkApplicationApi}.
 *
 * The API's request carries the comparison but not the baseline document, so a
 * report produced through it states the baseline's per-scenario statistics — the
 * comparison holds those — without the baseline's own identity and environment. A
 * caller that has the baseline document reaches {@link renderBenchmarkReport}
 * directly and gets the fuller report; this adapter exists so the published API
 * shape is satisfiable, not so the richer path is optional.
 */
export function createBenchmarkReportCapability(): BenchmarkApplicationApi["report"] {
  return async (request: BenchmarkReportRequest): Promise<BenchmarkReportDocument> =>
    renderBenchmarkReport(
      request.format,
      request.comparison === undefined
        ? { summary: request.summary }
        : { summary: request.summary, comparison: request.comparison },
    );
}
