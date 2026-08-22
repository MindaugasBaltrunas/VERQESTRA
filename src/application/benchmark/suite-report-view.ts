// Read-only view over the authoritative AG Loop benchmark report (etalono BENCH-10/BENCH-11,
// WBR VQ-305). Trys taisyklės: NIEKO neperskaičiuojama (BENCH-11 — raportas autoritetingas),
// benchmark paketas NEimportuojamas (jo formos veidrodis pin'inamas testu), failas skaitomas
// GYNYBIŠKAI (be symlink sekimo, su dydžio lubomis, be parserio teksto aido). VERQESTRA FS ir
// git HEAD ateina per portus — etalono tiesioginiai lstat/readFile/git spawn yra E4.
import path from "node:path";
import { z } from "zod";

/**
 * What an operator may conclude about the report on disk. `stale` is deliberately not an
 * error: the measurement still happened and is still evidence, it just cannot be shown to
 * describe the tree running now — the document is returned with it.
 */
export const BENCHMARK_REPORT_STATES = ["available", "stale", "corrupt", "missing"] as const;

export type BenchmarkReportState = (typeof BENCHMARK_REPORT_STATES)[number];

/** Repo-relative root of the benchmark workspace package. Absent in a packaged install. */
export const BENCHMARK_PACKAGE_RELATIVE_PATH = "AG/benchmark";

/** Repo-relative location of the generated JSON report (paketo write-benchmark-report veidrodis). */
export const BENCHMARK_REPORT_RELATIVE_PATH = `${BENCHMARK_PACKAGE_RELATIVE_PATH}/reports/benchmark-report.json`;

/** Mirrors `BENCHMARK_REPORT_SCHEMA_VERSION` of the benchmark package's report model. */
export const SUPPORTED_BENCHMARK_REPORT_SCHEMA_VERSION = 1;

/** The command that writes the report file (paketo `benchmark:report` script'as). */
export const BENCHMARK_REPORT_COMMAND = "pnpm --dir AG/benchmark benchmark:report";

/** Mirrors `COMPARISON_VERDICTS` of the benchmark package (BENCH-9). */
export const BENCHMARK_REPORT_VERDICTS = ["improved", "stable", "regressed", "inconclusive"] as const;

/** Mirrors `REPORT_VERDICT_BASES` of the benchmark package's report model. */
export const BENCHMARK_REPORT_VERDICT_BASES = ["comparison", "no-baseline"] as const;

/** A report larger than this is treated as unreadable rather than parsed into memory. */
export const MAX_BENCHMARK_REPORT_BYTES = 8 * 1024 * 1024;

/**
 * Gynybinio failų skaitymo portas: `statPath` niekada neseka symlink'o (lstat semantika) —
 * symlink'as vietoje raporto yra `other`, ne jo taikinys.
 */
export type BenchmarkFsPort = {
  statPath(absolutePath: string): Promise<{ kind: "file" | "directory" | "other" | "absent"; size: number }>;
  readTextFile(absolutePath: string): Promise<string>;
  /** Katalogo vardai, surūšiuoti; nesantis katalogas — tuščias sąrašas, ne klaida. */
  listDirectory(absoluteDir: string): Promise<readonly string[]>;
};

// Mažiausias vokas, kuris dokumentą daro BŪTENT šiuo raportu. Loose objektai visur: kiekvienas
// paketo pridėtas laukas privalo pasiekti klientą nepaliestas — orkestratorius čia kurjeris,
// ne autorius. Identiteto hash'ai yra `z.string()` be `.min(1)`: generatorius rašo tuščią
// `configHash`/`policyHash`, kai run pipeline jų neužfiksavo (BENCH-8) — reikalauti ne-tuščio
// reikštų kiekvieną realų raportą vadinti corrupt.
const reportIdentitySchema = z.looseObject({
  suiteHash: z.string(),
  configHash: z.string(),
  policyHash: z.string(),
  agCommit: z.string(),
});

const reportRunFactsSchema = z.looseObject({
  identity: reportIdentitySchema,
  sampleCount: z.number().int().nonnegative(),
});

const benchmarkReportDocumentSchema = z.looseObject({
  schemaVersion: z.number().int().positive(),
  verdict: z.enum(BENCHMARK_REPORT_VERDICTS),
  verdictBasis: z.enum(BENCHMARK_REPORT_VERDICT_BASES),
  reasons: z.array(z.string()),
  current: reportRunFactsSchema,
  modes: z.array(z.unknown()),
  scenarios: z.array(z.unknown()),
  limitations: z.array(z.string()),
  reproduction: z.looseObject({ command: z.string() }),
});

/** The report as the benchmark package wrote it — opaque evidence, forwarded verbatim. */
export type BenchmarkReportDocument = z.infer<typeof benchmarkReportDocumentSchema>;

/** Abu commit'ai, iš kurių daromas staleness sprendimas — `undefined` reiškia „patikra praleista". */
export interface BenchmarkReportFreshness {
  readonly reportedAgCommit: string | undefined;
  readonly currentAgCommit: string | undefined;
}

export interface BenchmarkReportSource {
  /** Repo-relative. A DTO served over HTTP never discloses a location on the host. */
  readonly path: string;
  readonly command: string;
}

export interface BenchmarkReportView {
  readonly state: BenchmarkReportState;
  /** Why the state is not `available`; `undefined` when it is. Free of host paths and file content. */
  readonly reason: string | undefined;
  readonly source: BenchmarkReportSource;
  readonly freshness: BenchmarkReportFreshness;
  /** The authoritative document, verbatim. Present for `available` and `stale`, absent otherwise. */
  readonly report: BenchmarkReportDocument | undefined;
}

export interface ReadBenchmarkReportOptions {
  readonly projectRoot?: string;
  /**
   * Resolves the AG commit to judge freshness against — composition (E5) paduoda git adapterį
   * su timeout'u. Nenurodžius patikra praleidžiama (`currentAgCommit: undefined`), o tai NĖRA
   * staleness įrodymas — ta pati taisyklė kaip `checkReleaseProofFreshness`.
   */
  readonly currentAgCommit?: (projectRoot: string) => Promise<string | undefined>;
}

const source: BenchmarkReportSource = Object.freeze({
  path: BENCHMARK_REPORT_RELATIVE_PATH,
  command: BENCHMARK_REPORT_COMMAND,
});

const noFreshness: BenchmarkReportFreshness = Object.freeze({
  reportedAgCommit: undefined,
  currentAgCommit: undefined,
});

function absolute(projectRoot: string, relative: string): string {
  return path.join(projectRoot, ...relative.split("/"));
}

/** Enough of a commit to recognise, short enough to read. */
function abbreviate(commit: string): string {
  return commit.slice(0, 12);
}

/**
 * Whether two recorded commits denote the same one. A run may record an abbreviated SHA while
 * `git rev-parse HEAD` returns the full one, so a prefix relation counts as a match; seven
 * characters is git's own minimum for an unambiguous abbreviation. Case-normalised — a SHA is
 * a hex string, not an identifier.
 */
function sameCommit(reported: string, current: string): boolean {
  const a = reported.toLowerCase();
  const b = current.toLowerCase();
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 7 && longer.startsWith(shorter);
}

function unreadable(
  state: "missing" | "corrupt",
  reason: string,
  freshness: BenchmarkReportFreshness = noFreshness,
): BenchmarkReportView {
  return { state, reason, source, freshness, report: undefined };
}

/** The first zod problem, as one line. Zod names the path within the document, never a file path. */
function describeSchemaFailure(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "the document does not match the benchmark report schema";
  const at = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${at}: ${issue.message}`;
}

/**
 * Where a parse failed, when the parser said — never *what* it read there: raporto baitų aidas
 * HTTP atsakyme paverstų svetimą failą disclosure kanalu.
 */
function describeParseFailure(error: unknown): string {
  const position = error instanceof Error ? /position (\d+)/.exec(error.message) : null;
  return position ? `is not valid JSON (at position ${position[1]})` : "is not valid JSON";
}

interface ReportBytes {
  readonly content?: string;
  readonly problem?: BenchmarkReportView;
}

async function readReportBytes(fs: BenchmarkFsPort, projectRoot: string): Promise<ReportBytes> {
  const reportPath = absolute(projectRoot, BENCHMARK_REPORT_RELATIVE_PATH);
  const stats = await fs.statPath(reportPath);

  if (stats.kind === "absent") {
    const packageStat = await fs.statPath(absolute(projectRoot, BENCHMARK_PACKAGE_RELATIVE_PATH));
    return {
      problem: unreadable(
        "missing",
        packageStat.kind !== "absent"
          ? `${BENCHMARK_REPORT_RELATIVE_PATH} does not exist. Generated reports are not committed; produce one with: ${BENCHMARK_REPORT_COMMAND}`
          : `${BENCHMARK_PACKAGE_RELATIVE_PATH} is not part of this installation, so no benchmark report can be produced here. The benchmark workspace ships with the AG Loop repository.`,
      ),
    };
  }

  if (stats.kind !== "file") {
    return {
      problem: unreadable(
        "corrupt",
        `${BENCHMARK_REPORT_RELATIVE_PATH} is not a regular file. The report is generated output and is read as written, never through a link.`,
      ),
    };
  }

  if (stats.size > MAX_BENCHMARK_REPORT_BYTES) {
    return {
      problem: unreadable(
        "corrupt",
        `${BENCHMARK_REPORT_RELATIVE_PATH} is larger than the ${MAX_BENCHMARK_REPORT_BYTES}-byte maximum this endpoint will read. Regenerate it with: ${BENCHMARK_REPORT_COMMAND}`,
      ),
    };
  }

  return { content: await fs.readTextFile(reportPath) };
}

/**
 * Reads the report and classifies it. Never throws for a report-shaped problem: missing,
 * unparsable or unattributable document is a STATE the operator is told about.
 */
export async function readBenchmarkReportView(
  fs: BenchmarkFsPort,
  options: ReadBenchmarkReportOptions = {},
): Promise<BenchmarkReportView> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const resolveCurrentCommit = options.currentAgCommit ?? ((): Promise<string | undefined> => Promise.resolve(undefined));

  const bytes = await readReportBytes(fs, projectRoot);
  if (bytes.problem) return bytes.problem;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.content ?? "");
  } catch (error: unknown) {
    return unreadable("corrupt", `${BENCHMARK_REPORT_RELATIVE_PATH} ${describeParseFailure(error)}`);
  }

  const validated = benchmarkReportDocumentSchema.safeParse(parsed);
  if (!validated.success) {
    return unreadable(
      "corrupt",
      `${BENCHMARK_REPORT_RELATIVE_PATH} is not a benchmark report — ${describeSchemaFailure(validated.error)}`,
    );
  }

  // Faktai skaitomi iš validuotos reikšmės, bet serviruojamas PARSED dokumentas: zod perstato
  // raktus, o raporto raktai rūšiuoti sąmoningai (BENCH-10 determinizmas).
  const envelope = validated.data;
  const report = parsed as BenchmarkReportDocument;

  // Nežinoma schemos versija raportuojama, ne rendinama: tos versijos laukai gali reikšti ką
  // kita, o įtikinamai atrodantis neteisingas skaičius blogiau už atsisakymą jį rodyti.
  if (envelope.schemaVersion !== SUPPORTED_BENCHMARK_REPORT_SCHEMA_VERSION) {
    return unreadable(
      "corrupt",
      `${BENCHMARK_REPORT_RELATIVE_PATH} declares schemaVersion ${envelope.schemaVersion}, which this build cannot read (expected ${SUPPORTED_BENCHMARK_REPORT_SCHEMA_VERSION}). Regenerate it with: ${BENCHMARK_REPORT_COMMAND}`,
    );
  }

  // Generatorius rašo tuščią commit'ą, kai negalėjo jo perskaityti, užuot išgalvojęs
  // atribuciją. Toks raportas niekada negali būti parodytas kaip aprašantis dabartinį medį —
  // serviruojamas kaip stale įrodymas (BENCH-12 būtent to ir reikia).
  const recordedCommit = envelope.current.identity.agCommit;
  if (recordedCommit === "") {
    return {
      state: "stale",
      reason:
        "the report records no AG commit, so it cannot be shown to describe the current tree. " +
        `Re-run the benchmark before relying on it: ${BENCHMARK_REPORT_COMMAND}`,
      source,
      freshness: { reportedAgCommit: undefined, currentAgCommit: await resolveCurrentCommit(projectRoot) },
      report,
    };
  }

  const currentAgCommit = await resolveCurrentCommit(projectRoot);
  const freshness: BenchmarkReportFreshness = { reportedAgCommit: recordedCommit, currentAgCommit };

  // Nežinomas HEAD nėra staleness įrodymas, tad jo ir negamina: raportas serviruojamas koks
  // yra, o `freshness.currentAgCommit === undefined` pasako, kad patikra praleista.
  if (currentAgCommit !== undefined && !sameCommit(recordedCommit, currentAgCommit)) {
    return {
      state: "stale",
      reason:
        `the report was measured on AG commit ${abbreviate(recordedCommit)}, but HEAD is ` +
        `${abbreviate(currentAgCommit)}. Re-run the benchmark before relying on it: ${BENCHMARK_REPORT_COMMAND}`,
      source,
      freshness,
      report,
    };
  }

  return { state: "available", reason: undefined, source, freshness, report };
}
