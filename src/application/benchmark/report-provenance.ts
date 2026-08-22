// Independent provenance verification for the BENCH-12 release gate (etalono BENCH-17,
// WBR VQ-305). Raportas anksčiau buvo tikimas savo paties `suiteHash`/`sampleCount`
// teiginiais — o `reports/` gitignore'intas, tad ranka parašytas failas su įtikinamu
// verdiktu perjungtų vartus į žalią. Šis modulis skaito DU artefaktus, kuriems raporto
// tapatybė turi būti atribuotina, ir nieko daugiau: `scenarios/suite.lock.json` (tracked)
// ir naujausia `results/runs/run-*.jsonl` (ledger'is). Nieko neperskaičiuoja (BENCH-11 metrikų savininkas
// lieka raportas) — tik atsako „ar raporto tapatybė atitinka įrodymus, kuriuos jis vardija".
import path from "node:path";
import { BENCHMARK_PACKAGE_RELATIVE_PATH, type BenchmarkFsPort } from "./suite-report-view.js";

/** Repo-relative location of the frozen suite identity. Tracked, unlike the report and the ledger. */
export const BENCHMARK_SUITE_LOCK_RELATIVE_PATH = `${BENCHMARK_PACKAGE_RELATIVE_PATH}/scenarios/suite.lock.json`;

/**
 * Repo-relative directory holding one ledger per run.
 *
 * The gate used to read a single `results/samples.jsonl`. The benchmark package stopped writing
 * that file when it moved to one ledger per run — with a shared file, a second run's ledger holds
 * the first run's samples, so `compare` would judge a run against a baseline that is a subset of
 * itself. The gate did not move with it, and because an absent ledger counts as zero samples, it
 * did not fail loudly: it silently blocked EVERY report claiming any sample at all, saying the
 * ledger held none. A provenance check whose evidence file no longer exists does not verify
 * anything; it just answers no.
 */
export const BENCHMARK_RUN_LEDGER_DIRECTORY = `${BENCHMARK_PACKAGE_RELATIVE_PATH}/results/runs`;

/**
 * The exact shape a run ledger's name has, mirroring `run-ledger-store.ts`.
 *
 * Restated rather than imported: this package may not reach into the benchmark package's
 * internals (BENCH-1), and the ledger directory is gitignored, so no test can pin the two against
 * a real file that a fresh clone has. Nothing enforces their agreement automatically — that is
 * stated plainly rather than papered over, because a comment claiming a guard that does not exist
 * is the reason nobody goes looking for the real one.
 *
 * What bounds the risk is the direction of the failure. A name this pattern stops recognising
 * makes the gate find no ledger, count zero samples, and block a report that claims any — loud
 * and fail-closed. It cannot turn into a silent pass.
 *
 * The tightness is load-bearing in the other direction too: a looser pattern would pick up the
 * `.unmeasured.jsonl` sidecar written beside a ledger, whose records are lost cells rather than
 * samples. Counting those would make a run look more complete the more of it failed.
 */
const RUN_LEDGER_NAME = /^run-\d{8}t\d{9}z\.jsonl$/;

const NEWLINE = "\n";

/** A file past this size is refused rather than parsed into memory. `suite.lock.json` is a few lines. */
const MAX_SUITE_LOCK_BYTES = 64 * 1024;

/** A file past this size is refused rather than parsed into memory. Generous for a text ledger. */
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;

export interface SuiteLockRead {
  /** The lock file's declared `suiteHash`. `undefined` only when the value could not be read. */
  readonly hash: string | undefined;
  /** Why `hash` is `undefined`; unset when it is not. */
  readonly problem: string | undefined;
}

export interface LedgerSampleCount {
  /** Records the ledger holds. `undefined` only when the count could not be established. */
  readonly count: number | undefined;
  /** Why `count` is `undefined`; unset when it is not. */
  readonly problem: string | undefined;
  /**
   * The ledger that was actually read, repo-relative; `undefined` when no run has been recorded.
   *
   * Published because the answer is no longer a fixed path. With one ledger per run, a gate that
   * named a constant would tell a reader which file the code was compiled against rather than
   * which file it read — and the whole point of this check is to say what the evidence was.
   */
  readonly source: string | undefined;
}

function absolute(projectRoot: string, relative: string): string {
  return path.join(projectRoot, ...relative.split("/"));
}

/**
 * Reads `scenarios/suite.lock.json` and returns the `suiteHash` it declares. Ta pati gynybinė
 * skaitymo poza kaip raporto: symlink'as niekada nesekamas, dydžio lubos prieš parse.
 */
export async function readSuiteLockHash(fs: BenchmarkFsPort, projectRoot: string): Promise<SuiteLockRead> {
  const lockPath = absolute(projectRoot, BENCHMARK_SUITE_LOCK_RELATIVE_PATH);
  const stats = await fs.statPath(lockPath);

  if (stats.kind === "absent") {
    return { hash: undefined, problem: `${BENCHMARK_SUITE_LOCK_RELATIVE_PATH} does not exist` };
  }
  if (stats.kind !== "file") {
    return { hash: undefined, problem: `${BENCHMARK_SUITE_LOCK_RELATIVE_PATH} is not a regular file` };
  }
  if (stats.size > MAX_SUITE_LOCK_BYTES) {
    return {
      hash: undefined,
      problem: `${BENCHMARK_SUITE_LOCK_RELATIVE_PATH} is larger than the ${MAX_SUITE_LOCK_BYTES}-byte maximum this check will read`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readTextFile(lockPath));
  } catch {
    return { hash: undefined, problem: `${BENCHMARK_SUITE_LOCK_RELATIVE_PATH} is not valid JSON` };
  }

  const hash = (parsed as { suiteHash?: unknown } | null)?.suiteHash;
  if (typeof hash !== "string" || hash === "") {
    return {
      hash: undefined,
      problem: `${BENCHMARK_SUITE_LOCK_RELATIVE_PATH} does not declare a non-empty suiteHash`,
    };
  }
  return { hash, problem: undefined };
}

/**
 * The newest run ledger, repo-relative, or `undefined` when no run has been recorded.
 *
 * Newest is the greatest name: `createRunId` puts a fixed-width UTC timestamp first precisely so
 * lexicographic order and chronological order are the same thing, with no index file that could
 * disagree with the directory it indexes.
 */
export async function findNewestRunLedger(
  fs: BenchmarkFsPort,
  projectRoot: string,
): Promise<string | undefined> {
  const directory = absolute(projectRoot, BENCHMARK_RUN_LEDGER_DIRECTORY);
  const names = (await fs.listDirectory(directory)).filter((name) => RUN_LEDGER_NAME.test(name));
  if (names.length === 0) return undefined;
  const newest = [...names].sort().at(-1);
  return newest === undefined ? undefined : `${BENCHMARK_RUN_LEDGER_DIRECTORY}/${newest}`;
}

/**
 * Counts the readable records in the newest run ledger.
 *
 * Nesantis ledger'is laiko nulį įrašų (tas pats, ką šviežias workspace duotų jo store
 * skaitytojui), bet EGZISTUOJANTIS ir pilnai neapskaitomas (neužbaigtas paskutinis įrašas,
 * tuščia eilutė, neparse'inama) neduoda JOKIO skaičiaus: skaičius per dalinį skaitymą nėra
 * skaičius, su kuriuo galima lyginti raporto teiginį.
 */
export async function countLedgerSamples(fs: BenchmarkFsPort, projectRoot: string): Promise<LedgerSampleCount> {
  const relative = await findNewestRunLedger(fs, projectRoot);
  if (relative === undefined) return { count: 0, problem: undefined, source: undefined };

  const ledgerPath = absolute(projectRoot, relative);
  const stats = await fs.statPath(ledgerPath);

  if (stats.kind === "absent") {
    return { count: 0, problem: undefined, source: relative };
  }
  if (stats.kind !== "file") {
    return { count: undefined, problem: `${relative} is not a regular file`, source: relative };
  }
  if (stats.size > MAX_LEDGER_BYTES) {
    return {
      count: undefined,
      problem: `${relative} is larger than the ${MAX_LEDGER_BYTES}-byte maximum this check will read`,
      source: relative,
    };
  }

  const text = await fs.readTextFile(ledgerPath);
  if (text === "") return { count: 0, problem: undefined, source: relative };

  const lines = text.split(NEWLINE);
  const unterminated = lines.pop() ?? "";
  if (unterminated !== "") {
    return {
      count: undefined,
      problem: `${relative} ends mid-record: the append that wrote it did not complete`,
      source: relative,
    };
  }

  let count = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      return {
        count: undefined,
        problem: `${relative} holds a blank line at record ${index + 1}`,
        source: relative,
      };
    }
    try {
      JSON.parse(line);
    } catch {
      return {
        count: undefined,
        problem: `${relative} holds an unreadable record at line ${index + 1}`,
        source: relative,
      };
    }
    count++;
  }
  return { count, problem: undefined, source: relative };
}
