import { mkdir, open, readdir, stat } from "node:fs/promises";
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

/**
 * How many milliseconds forward a colliding start time may be advanced before giving up.
 *
 * One second of ids. A caller that cannot find a free millisecond inside a whole second is not
 * racing another run; it is looking at a directory something else is filling, and inventing a
 * thousand-and-first id would hide that rather than answer it.
 */
const MAX_RUN_ID_ADVANCE_MS = 1_000;

/**
 * Suffix of the marker a run creates to claim its id.
 *
 * A dedicated file rather than the ledger or the sidecar. The ledger cannot serve: an empty one
 * created up front would become the newest run, and a run that crashed before storing anything
 * would then mask the last good run from `compare` and `baseline create`. The sidecar cannot
 * either: it is written later, with real content, by the pipeline itself.
 *
 * Invisible to every reader: {@link findLatestRunLedger} accepts only names ending in the ledger
 * suffix, the compression evidence scan reads only `.identity.json`, and the release gate's
 * restated pattern matches neither. It is left behind deliberately — an id that was once used
 * stays used, which is the whole job of an allocation marker.
 */
export const RUN_CLAIM_SUFFIX = ".claim";

/**
 * A run id claimed atomically, so two processes cannot be handed the same one.
 *
 * The id carries a millisecond timestamp and nothing else, which separates two runs started in the
 * same *second* and not two started in the same *millisecond*. The loser used to be killed by the
 * identity sidecar's `wx` — correct, and no data lost, since the identity is recorded before the
 * first cell runs and therefore before anything is spent, but a legitimate run died for a reason
 * its operator could not see.
 *
 * The first version of this function checked whether the id was free and then used it. That
 * narrowed the window without closing it: two processes that both look before either writes both
 * see a free millisecond. A check is not a claim.
 *
 * So the claim IS the write. `wx` on a marker file is atomic at the OS level — exactly one caller
 * creates it, and every other gets `EEXIST` and advances a millisecond. Chronology survives: the
 * second run really did start after the first, and a millisecond is finer than the thing being
 * measured. The name keeps its shape, so lexicographic order still equals chronological order and
 * nothing downstream learns anything new.
 */
export async function reserveRunId(
  startedAt: Date,
  packageRoot: string = BENCHMARK_PACKAGE_ROOT,
): Promise<string> {
  for (let advance = 0; advance < MAX_RUN_ID_ADVANCE_MS; advance += 1) {
    const runId = createRunId(new Date(startedAt.getTime() + advance));
    const ledger = runLedgerPath(runId);
    // A ledger or a sidecar already on disk means the id belongs to a run that finished, or to one
    // whose marker was cleaned away. Neither is claimable, and neither needs an atomic test.
    if (await pathExists(absolutePath(packageRoot, ledger))) continue;
    if (await pathExists(absolutePath(packageRoot, runIdentityPath(ledger)))) continue;
    if (await claimRunId(packageRoot, runId)) return runId;
  }
  throw new Error(
    `No free run id was available in the ${MAX_RUN_ID_ADVANCE_MS} millisecond(s) after ` +
      `${startedAt.toISOString()}; "${RUN_LEDGER_DIRECTORY}" already holds a claim for each of them.`,
  );
}

/** True when this caller created the marker; false when someone else already had. Never throws. */
async function claimRunId(packageRoot: string, runId: string): Promise<boolean> {
  const marker = absolutePath(packageRoot, `${RUN_LEDGER_DIRECTORY}/${runId}${RUN_CLAIM_SUFFIX}`);
  try {
    await mkdir(path.dirname(marker), { recursive: true });
    // `wx`: creates or fails. This is the whole mechanism — the atomicity is the filesystem's.
    const handle = await open(marker, "wx");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

function absolutePath(packageRoot: string, relative: string): string {
  return path.join(packageRoot, ...relative.split("/"));
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
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
