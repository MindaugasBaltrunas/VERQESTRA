import { readdir } from "node:fs/promises";
import path from "node:path";

import { BENCHMARK_PACKAGE_ROOT } from "./benchmark-workspace-paths.js";

/**
 * Where a run's samples are stored (BENCH-5).
 *
 * One JSON Lines ledger per run, in the schema `JsonlSampleStore` already
 * writes — this module adds no format, only a name and a way to find the newest
 * one.
 *
 * A single shared ledger would have been less machinery and would have been
 * wrong in a way that is hard to see afterwards. `baseline create` snapshots
 * what the ledger currently holds; `compare` reads the ledger as the current
 * run. With one file, the second run's ledger contains the first run's samples —
 * so a run would be compared against a baseline that is a subset of itself, and
 * the resulting verdict would be arithmetic on overlapping populations. Per-run
 * files make "this run" a fact about the filesystem rather than a convention
 * nobody can enforce.
 *
 * The newest run is the greatest file name, which is why {@link createRunId}
 * puts a fixed-width UTC timestamp first: it makes lexicographic order and
 * chronological order the same thing, without an index file that could disagree
 * with the directory it indexes.
 */

/** Package-relative directory holding one ledger per run. */
export const RUN_LEDGER_DIRECTORY = "results/runs";

const LEDGER_SUFFIX = ".jsonl";

/**
 * The exact shape {@link createRunId} produces, so a sidecar that also ends in
 * `.jsonl` — the timeout/unmeasured-cell trace `JsonlSampleStore` writes beside
 * a ledger (task 0028) — is never picked up here as though it were a run.
 */
const LEDGER_NAME_PATTERN = /^run-\d{8}t\d{9}z\.jsonl$/;

/**
 * `run-<yyyymmdd>t<hhmmssmmm>z`.
 *
 * Lowercase kebab-case with digits, which is what the worktree manager requires
 * of a run id (it becomes a branch and a directory name) and what the ledger
 * file name is built from. Milliseconds are included because two runs started in
 * the same second by different processes would otherwise share a ledger, and
 * appending one run's samples onto another's is exactly what per-run files
 * exist to prevent.
 */
export function createRunId(startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const millis = String(startedAt.getUTCMilliseconds()).padStart(3, "0");
  return `run-${stamp.toLowerCase()}${millis}z`;
}

/** Package-relative ledger path of `runId`, in POSIX form as every stored path is. */
export function runLedgerPath(runId: string): string {
  return `${RUN_LEDGER_DIRECTORY}/${runId}${LEDGER_SUFFIX}`;
}

/**
 * Suffix of the sidecar a run states its identity in (task 1205).
 *
 * A sidecar rather than a field: the stored-sample schema defines every key it
 * accepts and refuses the rest, and a header line inside the `.jsonl` would be
 * reported as a corrupt record — which makes the authoritative read path refuse
 * the whole ledger.
 */
export const RUN_IDENTITY_SUFFIX = ".identity.json";

/**
 * The identity sidecar belonging to `ledgerPath`.
 *
 * The ledger suffix is stripped when present, so `run-….jsonl` and its sidecar
 * differ by extension rather than by having two extensions; a `--samples` path
 * with any other extension still maps to exactly one deterministic sidecar
 * rather than to none.
 *
 * The sidecar is invisible to {@link findLatestRunLedger} by construction: that
 * function only accepts names ending in the ledger suffix, so writing one more
 * file into the run directory cannot make the newest *run* something other than
 * the newest ledger.
 */
export function runIdentityPath(ledgerPath: string): string {
  const base = ledgerPath.endsWith(LEDGER_SUFFIX)
    ? ledgerPath.slice(0, -LEDGER_SUFFIX.length)
    : ledgerPath;
  return `${base}${RUN_IDENTITY_SUFFIX}`;
}

/**
 * The ledger of the most recent run, or `undefined` when no run has been
 * executed.
 *
 * `undefined` rather than an empty ledger path: "no run happened" and "a run
 * happened and measured nothing" are different answers, and only the caller
 * knows which of them is an error in its context.
 */
export async function findLatestRunLedger(
  packageRoot: string = BENCHMARK_PACKAGE_ROOT,
): Promise<string | undefined> {
  let names: readonly string[];
  try {
    const entries = await readdir(path.join(packageRoot, ...RUN_LEDGER_DIRECTORY.split("/")), {
      withFileTypes: true,
    });
    names = entries
      .filter((entry) => entry.isFile() && LEDGER_NAME_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // A missing directory means no run has been executed here yet. Any other
    // read failure means the same thing to this function — it can name no
    // ledger — and the caller refuses rather than inventing one.
    return undefined;
  }
  const newest = names.at(-1);
  return newest === undefined ? undefined : `${RUN_LEDGER_DIRECTORY}/${newest}`;
}
