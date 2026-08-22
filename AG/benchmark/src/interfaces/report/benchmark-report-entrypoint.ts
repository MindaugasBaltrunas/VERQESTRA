import { pathToFileURL } from "node:url";

import type { RecordedCompressionConfig } from "../../application/ports/compression-config-port.js";
import { summarizeCompressionCohort } from "../../application/report/compression-report-section.js";
import {
  summarizeStoredSamples,
  type BenchmarkIdentity,
} from "../../application/report/benchmark-report-model.js";
import { AG_LOOP_ADAPTER_VERSION } from "../../infrastructure/adapters/ag-loop-execution-adapter.js";
import { AGENT_SOLO_ADAPTER_VERSION } from "../../infrastructure/adapters/agent-solo-execution-adapter.js";
import { DETERMINISTIC_CONTROL_ADAPTER_VERSION } from "../../infrastructure/adapters/deterministic-control-adapter.js";
import { HostEnvironmentAdapter } from "../../infrastructure/environment-capture.js";
import {
  createBenchmarkApplicationApi,
  readLatestRecordedRun,
  type BenchmarkCliCompositionOptions,
} from "../cli/benchmark-cli-composition.js";
import { writeBenchmarkReports, type BenchmarkReportWriteResult } from "./write-benchmark-report.js";

/**
 * `pnpm --dir AG/benchmark benchmark:report` (BENCH-10).
 *
 * Renders the JSON and Markdown report of whatever the sample ledger currently
 * holds and writes both into `reports/`. It is a *generator*, not a gate: it
 * exits non-zero when a report could not be produced, never because the verdict
 * inside it was unwelcome. The gate is `ag benchmark compare`, whose exit code is
 * the verdict's (`interfaces/cli/benchmark-cli.ts`).
 *
 * ## The identity is read, never re-derived
 *
 * The run pipeline records what a run measured, under which configuration and
 * under which policy, beside the ledger it wrote (BENCH-8, task 1205). When that
 * record is present this entry point adopts it whole — all five identity fields
 * and the environment — because mixing a live `suiteHash` with a recorded
 * `configHash` would publish an identity no run ever had. A suite that has moved
 * since is disclosed as a limitation rather than folded into the numbers.
 *
 * A ledger written before runs recorded their identity has none. Its
 * `configHash` and `policyHash` stay empty and the report says so, rather than
 * being filled with the methodology of the package as it stands today: an empty
 * `configHash` refuses a comparison under BENCH-8, and a fabricated one would
 * silently permit it. A record that exists and cannot be read is neither — it is
 * damaged provenance, and it fails the generation instead of degrading to a
 * limitation.
 *
 * The same stance applies to an empty ledger. Zero samples produce a real report
 * whose verdict is `inconclusive` and whose limitations say nothing was measured
 * — which is what BENCH-5 asks for, and the opposite of a missing file being read
 * as a clean run.
 */

/** Stated as unrecorded rather than filled in: the report never invents a hash. */
const UNRECORDED_HASH = "";

/**
 * The limitations this entry point can add, as values rather than as prose.
 *
 * A test that matched on the sentences would fail on a wording change and pass on
 * a rule change; binding to these keeps the assertion about the rule.
 */
export const REPORT_LIMITATIONS = {
  /** The scenario suite could not be read, so the report names no suite. */
  suiteNotValidated: (problems: readonly string[]): string =>
    `the scenario suite did not validate (${problems.length} problem(s)), so this ` +
    "report is not attributable to a known suite: " +
    problems.join("; "),

  /** Nothing was measured; every metric is unmeasured rather than zero. */
  emptyLedger:
    "the sample ledger holds no record, so nothing was measured and every metric in this " +
    "report is unmeasured rather than zero",

  /** The ledger predates the identity record, so it cannot be compared against a baseline. */
  unrecordedIdentity:
    "this run ledger was written before runs recorded their configuration and policy " +
    "identities, so its `configHash` and `policyHash` are unrecorded and BENCH-8 does not " +
    "permit this report to be compared against a baseline; re-run `ag benchmark run` to " +
    "produce an attributable ledger",

  /** Disclosure, not a gate: the report identifies the run that was measured. */
  suiteMovedSinceRun: (recorded: string, live: string): string =>
    "the scenario suite has changed since these samples were measured " +
    `(the run recorded ${recorded}, the working tree hashes to ${live}), so this report ` +
    "identifies the run that was measured rather than the suite as it stands now",

  /** The run could not read the compression configuration it executed under. */
  compressionConfigUnrecorded: (config: RecordedCompressionConfig): string =>
    `the compression configuration (\`${config.source}\`) was ${config.state} when this run was ` +
    "measured, so these numbers cannot be attributed to a compression configuration",
} as const;

export interface BenchmarkReportGenerationOptions extends BenchmarkCliCompositionOptions {
  /** Package-relative output directory; defaults to the reports directory. */
  readonly directory?: string;
  /** Where progress lines go. Defaults to standard output. */
  readonly out?: (line: string) => void;
}

function adapterVersions(): BenchmarkIdentity["modeAdapterVersions"] {
  return {
    "ag-loop": AG_LOOP_ADAPTER_VERSION,
    "agent-solo": AGENT_SOLO_ADAPTER_VERSION,
    "deterministic-control": DETERMINISTIC_CONTROL_ADAPTER_VERSION,
  };
}

/**
 * Builds and writes the current report.
 *
 * Exported so the generation path can be exercised against a temporary package
 * root without spawning a process.
 */
export async function generateBenchmarkReport(
  options: BenchmarkReportGenerationOptions = {},
): Promise<BenchmarkReportWriteResult> {
  const compositionOptions: BenchmarkCliCompositionOptions =
    options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot };

  const api = createBenchmarkApplicationApi(compositionOptions);

  // One ledger, read once: the samples and the identity below describe the same
  // run even if another run finishes while this report is being built.
  const [validation, ledger, environmentRecord] = await Promise.all([
    api.validate(),
    readLatestRecordedRun(compositionOptions),
    new HostEnvironmentAdapter(
      options.packageRoot === undefined ? {} : { cwd: options.packageRoot },
    ).captureRunEnvironment(),
  ]);

  const { samples, record } = ledger;
  const suiteIsUsable = validation.problems.length === 0;
  // A refused suite names no hash: reporting the hash of a suite whose contents
  // were rejected would let a reader record it as evidence of a measurement.
  const liveSuiteHash = suiteIsUsable ? validation.suiteHash : UNRECORDED_HASH;
  const identity: BenchmarkIdentity =
    record === undefined
      ? {
          suiteHash: liveSuiteHash,
          configHash: UNRECORDED_HASH,
          policyHash: UNRECORDED_HASH,
          agCommit: environmentRecord.agCommit,
          modeAdapterVersions: adapterVersions(),
        }
      : // Adopted whole rather than field by field: every one of these was
        // observed by the run that produced the samples, and a hash taken now
        // would describe a methodology those samples were not measured under.
        record.identity;
  const environment =
    record === undefined ? environmentRecord.environment : record.environment.environment;

  const limitations: string[] = [];
  if (!suiteIsUsable) {
    limitations.push(REPORT_LIMITATIONS.suiteNotValidated(validation.problems));
  }
  if (samples.length === 0) {
    limitations.push(REPORT_LIMITATIONS.emptyLedger);
  }
  if (record === undefined) {
    limitations.push(REPORT_LIMITATIONS.unrecordedIdentity);
  } else {
    if (liveSuiteHash !== UNRECORDED_HASH && liveSuiteHash !== record.identity.suiteHash) {
      limitations.push(
        REPORT_LIMITATIONS.suiteMovedSinceRun(record.identity.suiteHash, liveSuiteHash),
      );
    }
    if (record.compressionConfig.state !== "read") {
      limitations.push(REPORT_LIMITATIONS.compressionConfigUnrecorded(record.compressionConfig));
    }
  }

  return writeBenchmarkReports(
    {
      summary: summarizeStoredSamples({ identity, environment, samples }),
      // Always summarised, including over an empty ledger: the cohort's job is
      // to say what is not measured, and omitting the section when nothing was
      // recorded would leave the report silent exactly when a reader is most
      // likely to assume compression was proven.
      compression: summarizeCompressionCohort(samples),
      limitations,
    },
    {
      ...compositionOptions,
      ...(options.directory === undefined ? {} : { directory: options.directory }),
    },
  );
}

/** Generates the report and reports where it landed. Returns the process exit code. */
export async function runBenchmarkReportGeneration(
  options: BenchmarkReportGenerationOptions = {},
): Promise<number> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const result = await generateBenchmarkReport(options);
  out(`benchmark report: ${result.rendered.model.verdict} (${result.rendered.model.verdictBasis})`);
  for (const written of result.written) {
    out(`  ${written.format.padEnd(8)} ${written.relativePath}`);
  }
  out(`  limitations ${result.rendered.model.limitations.length}`);
  return 0;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (invokedDirectly()) {
  runBenchmarkReportGeneration()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
