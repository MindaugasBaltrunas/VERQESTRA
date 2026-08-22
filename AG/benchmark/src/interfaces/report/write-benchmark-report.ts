import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BenchmarkReportFormat } from "../../application/benchmark-api.js";
import type { BenchmarkReportInput } from "../../application/report/benchmark-report-model.js";
import {
  renderAllBenchmarkReports,
  type RenderedBenchmarkReport,
} from "../../application/report/benchmark-report.js";
import {
  BENCHMARK_PACKAGE_ROOT,
  resolveInsideBenchmarkWorkspace,
} from "../../infrastructure/benchmark-workspace-paths.js";

/**
 * Report delivery (BENCH-10).
 *
 * Renders both formats from a single model and writes them side by side. The
 * rendering itself is the application layer's; what this module adds is the part
 * that touches a disk, and the two rules that govern it:
 *
 * - **The target is inside the package.** The directory is resolved through
 *   `resolveInsideBenchmarkWorkspace`, so a caller-supplied name can never place
 *   a report outside the benchmark workspace.
 * - **The pair is written from one model.** Emitting the JSON from one render and
 *   the Markdown from another would let a run change between them; here the two
 *   files are two encodings of the same value, which is what makes them
 *   comparable evidence rather than two opinions.
 *
 * The bytes are written exactly as rendered — line endings included — so a report
 * regenerated on another platform differs only where the measurement differs.
 */

/** Package-relative directory the generated reports live in. */
export const BENCHMARK_REPORT_DIRECTORY = "reports";

/** File name per format. Fixed, so the newest report is always at the same path and diffs against the previous one. */
export const BENCHMARK_REPORT_FILE_NAMES: Readonly<Record<BenchmarkReportFormat, string>> =
  Object.freeze({
    json: "benchmark-report.json",
    markdown: "benchmark-report.md",
  });

export interface WrittenBenchmarkReport {
  readonly format: BenchmarkReportFormat;
  /** Package-relative: what a log line and a commit message may show without disclosing the author's machine. */
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface WriteBenchmarkReportOptions {
  /** The benchmark package directory. Defaults to this package. */
  readonly packageRoot?: string;
  /** Package-relative output directory. Defaults to {@link BENCHMARK_REPORT_DIRECTORY}. */
  readonly directory?: string;
}

export interface BenchmarkReportWriteResult {
  readonly rendered: RenderedBenchmarkReport;
  /** In the order {@link BENCHMARK_REPORT_FORMATS} declares the formats. */
  readonly written: readonly WrittenBenchmarkReport[];
}

/**
 * Renders the report and writes every format into the reports directory.
 *
 * The directory is created if it does not exist; nothing else in it is touched,
 * so an earlier report kept under another name survives.
 */
export async function writeBenchmarkReports(
  input: BenchmarkReportInput,
  options: WriteBenchmarkReportOptions = {},
): Promise<BenchmarkReportWriteResult> {
  const packageRoot = options.packageRoot ?? BENCHMARK_PACKAGE_ROOT;
  const directory = options.directory ?? BENCHMARK_REPORT_DIRECTORY;
  const absoluteDirectory = resolveInsideBenchmarkWorkspace(directory, packageRoot);

  const rendered = renderAllBenchmarkReports(input);
  await mkdir(absoluteDirectory, { recursive: true });

  const written: WrittenBenchmarkReport[] = [];
  for (const document of rendered.documents) {
    const fileName = BENCHMARK_REPORT_FILE_NAMES[document.format];
    const relativePath = path.posix.join(directory.split(path.sep).join("/"), fileName);
    const absolutePath = path.join(absoluteDirectory, fileName);
    // Sequential rather than concurrent: two writes into one directory that fail
    // halfway should leave one complete report, not two half-written ones.
    await writeFile(absolutePath, document.content, "utf8");
    written.push({ format: document.format, relativePath, absolutePath });
  }

  return { rendered, written };
}
