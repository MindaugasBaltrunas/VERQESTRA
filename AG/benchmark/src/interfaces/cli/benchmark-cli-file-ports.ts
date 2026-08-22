// The CLI ports that touch the filesystem: reading ledgers and baselines, writing baselines and
// reports.
//
// Moved VERBATIM out of `benchmark-cli-composition.ts`. Every one of them is a path decision and a
// read or a write, with no judgement in it — which is part of why they sat unexamined inside an
// 800-line file for as long as they did, and why they belong somewhere a reader can see all of
// them at once.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BenchmarkRunRefusedError,
  type BenchmarkApplicationApi,
  type BenchmarkRunSummary,
} from "../../application/benchmark-api.js";
import { readBaseline, serializeBaseline } from "../../application/baseline/baseline-document.js";
import {
  describeValidationProblem,
  readAuthoritativeSamples,
} from "../../application/sample-ledger.js";
import { resolveInsideBenchmarkWorkspace } from "../../infrastructure/benchmark-workspace-paths.js";
import { JsonlSampleStore } from "../../infrastructure/jsonl-sample-store.js";
import { findLatestRunLedger } from "../../infrastructure/run-ledger-store.js";
import type { BenchmarkCliPorts } from "./benchmark-cli.js";

/** Package-relative directory sealed baseline documents are written to. */
export const BASELINE_DIRECTORY = "baselines";

export function createFilePorts(
  api: BenchmarkApplicationApi,
  packageRoot: string,
  loadCurrentSummary: () => Promise<BenchmarkRunSummary>,
): BenchmarkCliPorts {
  return {
    api,

    async loadSamples(samplesPath) {
      // Without a path: the newest run ledger, and an empty list when no run has
      // been executed. Empty rather than a refusal, because this port also feeds
      // the report generator, whose job is to publish "nothing was measured" as
      // a readable finding rather than as a failure to produce a document.
      const ledger = samplesPath ?? (await findLatestRunLedger(packageRoot));
      if (ledger === undefined) return [];
      // The path is data — a CLI flag — so it is resolved against the workspace
      // root by the store rather than trusted as given.
      return readAuthoritativeSamples(new JsonlSampleStore(ledger, packageRoot));
    },

    async loadBaseline(baselinePath) {
      const absolute = resolveInsideBenchmarkWorkspace(baselinePath, packageRoot);
      const document = readBaseline(JSON.parse(await readFile(absolute, "utf8")));
      if (!document.ok) {
        throw new BenchmarkRunRefusedError([
          `"${baselinePath}" is not a readable baseline document`,
          ...document.problems.map((problem) => describeValidationProblem(problem)),
        ]);
      }
      return document.value;
    },

    loadCurrentSummary,

    async saveBaseline(baseline, outPath) {
      const relative = outPath ?? `${BASELINE_DIRECTORY}/${baseline.manifest.baselineId}.json`;
      const absolute = resolveInsideBenchmarkWorkspace(relative, packageRoot);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, serializeBaseline(baseline), "utf8");
      return relative;
    },

    async writeReport(content, outPath) {
      const absolute = resolveInsideBenchmarkWorkspace(outPath, packageRoot);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
      return outPath;
    },
    };
}
