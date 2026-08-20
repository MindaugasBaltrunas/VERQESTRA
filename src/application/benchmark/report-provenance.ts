// Independent provenance verification for the BENCH-12 release gate (etalono BENCH-17,
// WBR VQ-305). Raportas anksčiau buvo tikimas savo paties `suiteHash`/`sampleCount`
// teiginiais — o `reports/` gitignore'intas, tad ranka parašytas failas su įtikinamu
// verdiktu perjungtų vartus į žalią. Šis modulis skaito DU artefaktus, kuriems raporto
// tapatybė turi būti atribuotina, ir nieko daugiau: `scenarios/suite.lock.json` (tracked)
// ir `results/samples.jsonl` (ledger'is). Nieko neperskaičiuoja (BENCH-11 metrikų savininkas
// lieka raportas) — tik atsako „ar raporto tapatybė atitinka įrodymus, kuriuos jis vardija".
import path from "node:path";
import { BENCHMARK_PACKAGE_RELATIVE_PATH, type BenchmarkFsPort } from "./suite-report-view.js";

/** Repo-relative location of the frozen suite identity. Tracked, unlike the report and the ledger. */
export const BENCHMARK_SUITE_LOCK_RELATIVE_PATH = `${BENCHMARK_PACKAGE_RELATIVE_PATH}/scenarios/suite.lock.json`;

/** Repo-relative location of the sample ledger a report's `current.sampleCount` is drawn from. */
export const BENCHMARK_SAMPLE_LEDGER_RELATIVE_PATH = `${BENCHMARK_PACKAGE_RELATIVE_PATH}/results/samples.jsonl`;

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
 * Counts the readable records in `results/samples.jsonl`.
 *
 * Neegzistuojantis ledger'is laiko nulį įrašų (tas pats, ką šviežias workspace duotų jo
 * store skaitytojui), bet EGZISTUOJANTIS ir pilnai neapskaitomas (neužbaigtas paskutinis
 * įrašas, tuščia eilutė, neparse'inama) neduoda JOKIO skaičiaus: skaičius per dalinį
 * skaitymą nėra skaičius, su kuriuo galima lyginti raporto teiginį.
 */
export async function countLedgerSamples(fs: BenchmarkFsPort, projectRoot: string): Promise<LedgerSampleCount> {
  const ledgerPath = absolute(projectRoot, BENCHMARK_SAMPLE_LEDGER_RELATIVE_PATH);
  const stats = await fs.statPath(ledgerPath);

  if (stats.kind === "absent") {
    return { count: 0, problem: undefined };
  }
  if (stats.kind !== "file") {
    return { count: undefined, problem: `${BENCHMARK_SAMPLE_LEDGER_RELATIVE_PATH} is not a regular file` };
  }
  if (stats.size > MAX_LEDGER_BYTES) {
    return {
      count: undefined,
      problem: `${BENCHMARK_SAMPLE_LEDGER_RELATIVE_PATH} is larger than the ${MAX_LEDGER_BYTES}-byte maximum this check will read`,
    };
  }

  const text = await fs.readTextFile(ledgerPath);
  if (text === "") return { count: 0, problem: undefined };

  const lines = text.split("\n");
  const unterminated = lines.pop() ?? "";
  if (unterminated !== "") {
    return {
      count: undefined,
      problem: `${BENCHMARK_SAMPLE_LEDGER_RELATIVE_PATH} ends mid-record: the append that wrote it did not complete`,
    };
  }

  let count = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      return {
        count: undefined,
        problem: `${BENCHMARK_SAMPLE_LEDGER_RELATIVE_PATH} holds a blank line at record ${index + 1}`,
      };
    }
    try {
      JSON.parse(line);
    } catch {
      return {
        count: undefined,
        problem: `${BENCHMARK_SAMPLE_LEDGER_RELATIVE_PATH} holds an unreadable record at line ${index + 1}`,
      };
    }
    count++;
  }
  return { count, problem: undefined };
}
