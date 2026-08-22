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

/**
 * The mode a stored sample declares, or `undefined` when the record is not one.
 *
 * The check counted `JSON.parse` successes, which made every JSON object a sample: a ledger of
 * ninety-nine `{"a":1}` lines answered "ninety-nine samples" and matched a report claiming as
 * many. The official reader (`readAuthoritativeSamples`) would refuse every one of them, so the
 * gate was strictly weaker than the tool whose output it verifies — the one direction a
 * verification may never be weaker in.
 *
 * The fields below are the identifying minimum, restated rather than imported: BENCH-1 forbids
 * this package from reaching into the benchmark package's schema. It is deliberately NARROWER
 * than that schema and makes no attempt to match it — a record passing here is not thereby a
 * valid sample, only a record that could be one. Anything more would be this module recomputing
 * what the benchmark package owns.
 */
function sampleMode(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
  const value = record as Record<string, unknown>;
  const identifying = ["sampleId", "scenarioId", "mode"] as const;
  if (identifying.some((field) => typeof value[field] !== "string" || value[field] === "")) {
    return undefined;
  }
  if (!Number.isInteger(value["repetition"])) return undefined;
  // The cost record is what a benchmark sample exists to carry; a record without one is not a
  // measurement whatever else it holds.
  const telemetry = value["telemetry"];
  if (typeof telemetry !== "object" || telemetry === null) return undefined;
  return String(value["mode"]);
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
  /**
   * How many samples the ledger holds per mode.
   *
   * Published because a total alone is forgeable by repetition: ninety-nine records of any shape
   * make ninety-nine. The report states its own per-mode counts, and two independently produced
   * distributions agreeing is a much narrower coincidence than two totals agreeing.
   */
  readonly perMode: ReadonlyMap<string, number>;
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
  if (relative === undefined) return { count: 0, problem: undefined, source: undefined, perMode: new Map() };

  const ledgerPath = absolute(projectRoot, relative);
  const stats = await fs.statPath(ledgerPath);

  if (stats.kind === "absent") {
    return { count: 0, problem: undefined, source: relative, perMode: new Map() };
  }
  if (stats.kind !== "file") {
    return {
      count: undefined,
      problem: `${relative} is not a regular file`,
      source: relative,
      perMode: new Map(),
    };
  }
  if (stats.size > MAX_LEDGER_BYTES) {
    return {
      count: undefined,
      problem: `${relative} is larger than the ${MAX_LEDGER_BYTES}-byte maximum this check will read`,
      source: relative,
      perMode: new Map(),
    };
  }

  const text = await fs.readTextFile(ledgerPath);
  if (text === "") return { count: 0, problem: undefined, source: relative, perMode: new Map() };

  const lines = text.split(NEWLINE);
  const unterminated = lines.pop() ?? "";
  if (unterminated !== "") {
    return {
      count: undefined,
      problem: `${relative} ends mid-record: the append that wrote it did not complete`,
      source: relative,
      perMode: new Map(),
    };
  }

  let count = 0;
  const perMode = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      return {
        count: undefined,
        problem: `${relative} holds a blank line at record ${index + 1}`,
        source: relative,
        perMode: new Map(),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return {
        count: undefined,
        problem: `${relative} holds an unreadable record at line ${index + 1}`,
        source: relative,
        perMode: new Map(),
      };
    }
    const mode = sampleMode(parsed);
    if (mode === undefined) {
      return {
        count: undefined,
        problem: `${relative} holds a record at line ${index + 1} that is not a stored sample`,
        source: relative,
        perMode: new Map(),
      };
    }
    perMode.set(mode, (perMode.get(mode) ?? 0) + 1);
    count++;
  }
  return { count, problem: undefined, source: relative, perMode };
}

/**
 * Suffix of the sidecar a run states its identity in. Mirrors the benchmark package's
 * `RUN_IDENTITY_SUFFIX`, restated for the same reason the ledger name pattern is (BENCH-1).
 */
export const RUN_IDENTITY_SUFFIX = ".identity.json";

/** A sidecar is a few hashes and a configuration; anything larger is refused before parsing. */
const MAX_RUN_IDENTITY_BYTES = 1024 * 1024;

/** The four hashes a run states about itself. Every one is a string the report must reproduce. */
export interface RecordedRunIdentity {
  readonly suiteHash: string;
  readonly configHash: string;
  readonly policyHash: string;
  readonly agCommit: string;
}

export interface RunIdentityRead {
  /** Absent when the run recorded no identity — a legacy ledger — or when one could not be read. */
  readonly identity: RecordedRunIdentity | undefined;
  /** Set only when a sidecar EXISTS and is unusable. A legacy ledger leaves both fields unset. */
  readonly problem: string | undefined;
}

/**
 * The identity the run behind `ledgerRelative` recorded about itself.
 *
 * Read from the sidecar of THAT ledger rather than by scanning the directory: the gate has
 * already decided which ledger it counted, and a second, independent "find the newest" would let
 * the count and the identity describe different runs — the very confusion the sidecar exists to
 * settle.
 *
 * An absent sidecar is not a problem. It means a ledger written before runs recorded an identity,
 * and refusing those would make every stored run unverifiable at once. A sidecar that exists and
 * cannot be read IS a problem: a run that stated its identity and cannot be asked what it said is
 * not evidence anything may be attributed to.
 */
export async function readRunIdentity(
  fs: BenchmarkFsPort,
  projectRoot: string,
  ledgerRelative: string,
): Promise<RunIdentityRead> {
  const relative = `${ledgerRelative.replace(/\.jsonl$/, "")}${RUN_IDENTITY_SUFFIX}`;
  const sidecarPath = absolute(projectRoot, relative);
  const stats = await fs.statPath(sidecarPath);

  if (stats.kind === "absent") return { identity: undefined, problem: undefined };
  if (stats.kind !== "file") {
    return { identity: undefined, problem: `${relative} is not a regular file` };
  }
  if (stats.size > MAX_RUN_IDENTITY_BYTES) {
    return {
      identity: undefined,
      problem: `${relative} is larger than the ${MAX_RUN_IDENTITY_BYTES}-byte maximum this check will read`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readTextFile(sidecarPath));
  } catch {
    return { identity: undefined, problem: `${relative} is not valid JSON` };
  }

  const identity = (parsed as { identity?: unknown } | null)?.identity;
  if (typeof identity !== "object" || identity === null) {
    return { identity: undefined, problem: `${relative} declares no identity block` };
  }

  const read = identity as Record<string, unknown>;
  const fields: readonly (keyof RecordedRunIdentity)[] = [
    "suiteHash",
    "configHash",
    "policyHash",
    "agCommit",
  ];
  const missing = fields.filter((field) => typeof read[field] !== "string");
  if (missing.length > 0) {
    return { identity: undefined, problem: `${relative} declares no ${missing.join(", ")}` };
  }

  return {
    identity: {
      suiteHash: String(read["suiteHash"]),
      configHash: String(read["configHash"]),
      policyHash: String(read["policyHash"]),
      agCommit: String(read["agCommit"]),
    },
    problem: undefined,
  };
}
