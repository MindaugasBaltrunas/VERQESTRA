// release-readiness use case: BENCH-12 release vartai (etalono benchmark-evidence-check.ts,
// WBR VQ-305). Final audit privalo blokuoti SĖKMĖS DEKLARACIJĄ, kai benchmark įrodymas
// pasenęs, nepilnas arba `regressed`. Nieko neperskaičiuoja ir verdikto neišveda iš naujo
// (BENCH-11 — raportas autoritetingas): tik skaito jį per suite-report-view ir taiko
// dokumentuotą politiką.
//
// Politikos lentelė (kodėl kiekviena eilutė ten, kur yra):
// | AG/benchmark nėra | not_applicable | benchmark'as matuoja patį AG Loop ir su install'intu
//   target projektu nekeliauja — blokuoti to projekto release dėl paketo, kurio jis niekada
//   neturėjo, būtų vartai apie nieką |
// | raporto nėra | blocked | repo benchmark'ą turi ir jo nepaleido; „niekada nematavom" negali
//   skaitytis kaip „niekas neregresavo" |
// | raportas corrupt/stale | blocked | neperskaitomas dokumentas nėra įrodymas; pamatuota ant
//   kito commit'o — aprašo kitą medį (BENCH-8) |
// | 0 sample'ų | blocked | raportas virš tuščio ledger'io realus ir sąžiningas — ir nieko
//   nepamatavo |
// | suiteHash/sampleCount neatitinka artefaktų | blocked | raportas neatribuotinas (BENCH-17) |
// | raporto tapatybė neatitinka run'o sidecar'o | blocked | raportas aprašo KITĄ paleidimą nei tas,
//   kurio ledger'is suskaičiuotas |
// | verdictBasis no-baseline / verdict inconclusive | blocked | „negalėjom pasakyti" nėra
//   „viskas gerai" |
// | verdict regressed | blocked | matavimas sako, kad pablogėjo |
// | improved/stable ant šviežio, atribuoto raporto | ok | vienintelė kombinacija, palaikanti
//   sėkmės deklaraciją |
import {
  countLedgerSamples,
  readSuiteLockHash,
  BENCHMARK_RUN_LEDGER_DIRECTORY,
  readRunIdentity,
  BENCHMARK_SUITE_LOCK_RELATIVE_PATH,
} from "../benchmark/report-provenance.js";
import {
  BENCHMARK_PACKAGE_RELATIVE_PATH,
  BENCHMARK_REPORT_COMMAND,
  BENCHMARK_REPORT_RELATIVE_PATH,
  readBenchmarkReportView,
  type BenchmarkFsPort,
  type BenchmarkReportView,
} from "../benchmark/suite-report-view.js";
import path from "node:path";

export type BenchmarkEvidenceStatus = "ok" | "blocked" | "not_applicable";

export type BenchmarkEvidenceCheckResult = {
  ok: boolean;
  status: BenchmarkEvidenceStatus;
  /** The report's own state, or `not_installed` when the package is not part of this repository. */
  report_state: BenchmarkReportView["state"] | "not_installed";
  /** The authoritative verdict, when a readable report carried one. */
  verdict?: string;
  issues: string[];
};

/** The one-line status the committed release proof records for this gate. */
export function describeBenchmarkEvidence(result: BenchmarkEvidenceCheckResult): string {
  if (result.status === "not_applicable") return "not_applicable (benchmark package not installed)";
  if (result.status === "ok") return `ok (${result.verdict ?? "no verdict"})`;
  return `blocked: ${result.issues[0] ?? result.report_state}`;
}

export type CheckBenchmarkEvidenceOptions = {
  /** Freshness palyginimo commit resolveris (git adapteris — E5); testai injektuoja fake. */
  currentAgCommit?: (projectRoot: string) => Promise<string | undefined>;
};

export async function checkBenchmarkEvidence(
  fs: BenchmarkFsPort,
  projectRoot: string,
  options: CheckBenchmarkEvidenceOptions = {},
): Promise<BenchmarkEvidenceCheckResult> {
  const root = path.resolve(projectRoot);

  // Klausiama PRIEŠ skaitant raportą ir ne iš skaitytojo „missing" priežasties prozos:
  // „ši instaliacija benchmark'o neturi" ir „šis repo savo benchmark'o nepaleido" yra
  // priešingos išvados, ir vartai negali jų skirti pagal teksto match'ą.
  const packageStat = await fs.statPath(path.join(root, ...BENCHMARK_PACKAGE_RELATIVE_PATH.split("/")));
  if (packageStat.kind !== "directory") {
    return { ok: true, status: "not_applicable", report_state: "not_installed", issues: [] };
  }

  // Atkartoja checkArchitectureBoundary klaidų apdorojimą: vartų vidinė klaida raportuojama
  // kaip blocked vartai, o ne metama — negali nugriauti visos final-audit kompozicijos.
  let view: BenchmarkReportView;
  try {
    view = await readBenchmarkReportView(fs, {
      projectRoot: root,
      ...(options.currentAgCommit === undefined ? {} : { currentAgCommit: options.currentAgCommit }),
    });
  } catch (error: unknown) {
    return {
      ok: false,
      status: "blocked",
      report_state: "corrupt",
      issues: [`benchmark-evidence-check:${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const blocked = (issues: string[], verdict?: string): BenchmarkEvidenceCheckResult => ({
    ok: false,
    status: "blocked",
    report_state: view.state,
    ...(verdict === undefined ? {} : { verdict }),
    issues,
  });

  if (view.state === "missing") {
    return blocked([
      `benchmark evidence is missing: ${BENCHMARK_REPORT_RELATIVE_PATH} does not exist. ` +
        `Run the benchmark and generate the report (${BENCHMARK_REPORT_COMMAND}) before declaring success.`,
    ]);
  }
  if (view.state === "corrupt") {
    return blocked([`benchmark evidence is unreadable: ${view.reason ?? "the report could not be parsed"}`]);
  }
  if (view.state === "stale") {
    return blocked([`benchmark evidence is stale: ${view.reason ?? "the report describes another commit"}`]);
  }

  const report = view.report;
  if (report === undefined) {
    // Nepasiekiama, kol `available` visada neša dokumentą; palikta, nes vartai, kurie čia
    // dereferencuotų `undefined`, nugriautų final audit vietoje jo blokavimo.
    return blocked([
      "benchmark evidence is incomplete: the report was classified as available but carries no document",
    ]);
  }

  const verdict = String(report.verdict);
  const issues: string[] = [];

  if (report.current.sampleCount === 0) {
    issues.push(
      "benchmark evidence is incomplete: the report covers 0 samples, so nothing was measured " +
        "and every metric in it is unmeasured rather than zero",
    );
  }

  // BENCH-17: raporto teiginiai tikrinami prieš artefaktus, kuriuos jie vardija, o ne tikimi.
  // Nė vienas skaitymas neperskaičiuoja metrikos — lyginama eilutė ir skaičius.
  const suiteLock = await readSuiteLockHash(fs, root);
  if (suiteLock.hash === undefined) {
    issues.push(`benchmark evidence is incomplete: the suite lock could not be read (${suiteLock.problem})`);
  } else if (suiteLock.hash !== report.current.identity.suiteHash) {
    issues.push(
      `benchmark evidence does not match the tracked suite: the report's suiteHash ` +
        `(${report.current.identity.suiteHash || "<empty>"}) does not match ` +
        `${BENCHMARK_SUITE_LOCK_RELATIVE_PATH} (${suiteLock.hash})`,
    );
  }

  const ledger = await countLedgerSamples(fs, root);
  if (ledger.count === undefined) {
    issues.push(`benchmark evidence is incomplete: the sample ledger could not be read (${ledger.problem})`);
  } else if (ledger.count !== report.current.sampleCount) {
    // Ivardijamas TAS ledger'is, kuris buvo perskaitytas, o ne konstanta. Su vienu ledger'iu per
    // run'a konstanta pasakytu, pagal kuri faila kodas sukompiliuotas, o ne kuri jis skaite —
    // ir butent tai leido sitiems vartams tyliai blokuoti kiekviena raporta, kai paketas
    // persikele i `results/runs/`, o vartai liko prie `results/samples.jsonl`.
    const named = ledger.source ?? `${BENCHMARK_RUN_LEDGER_DIRECTORY} (no run ledger)`;
    issues.push(
      `benchmark evidence does not match its ledger: the report claims ${report.current.sampleCount} ` +
        `sample(s) but ${named} holds ${ledger.count}`,
    );
  }

  // BENCH-17 antra pusė: raportas privalo aprašyti TĄ run'ą, kurio ledger'į ką tik suskaičiavome.
  //
  // `suiteHash` prieš `suite.lock.json` atsako į kitą klausimą — ar tai apskritai tracked rinkinys.
  // Jis nieko nesako apie tai, KURIS paleidimas pagamino skaičius: `reports/` yra gitignore'intas
  // ir generuojamas rankiniu paleidimu, o ledger'is keičiasi po kiekvieno run'o. Raportas,
  // sugeneruotas iš run'o A, ir po jo įvykęs run'as B duoda tą patį `suiteHash`, o `sampleCount`
  // gali sutapti — ir vartai praleistų raportą apie kitą paleidimą.
  //
  // Sidecar'as skaitomas TO PAČIO ledger'io, ne atskiru „rask naujausią": du nepriklausomi
  // ieškojimai leistų skaičiui ir tapatybei aprašyti skirtingus run'us, t. y. tiksliai tą painiavą,
  // kuriai spręsti sidecar'as ir egzistuoja.
  //
  // Nesantis sidecar'as NĖRA problema: taip atrodo ledger'is, rašytas prieš atsirandant įrašui, ir
  // jų atmetimas iškart padarytų kiekvieną saugomą run'ą nepatikrinamą.
  if (ledger.source !== undefined) {
    const recorded = await readRunIdentity(fs, root, ledger.source);
    if (recorded.problem !== undefined) {
      issues.push(`benchmark evidence is incomplete: the run identity could not be read (${recorded.problem})`);
    } else if (recorded.identity !== undefined) {
      for (const [field, recordedValue] of Object.entries(recorded.identity)) {
        const claimed = report.current.identity[field as keyof typeof recorded.identity] ?? "";
        if (claimed !== recordedValue) {
          issues.push(
            `benchmark evidence describes another run: the report's ${field} ` +
              `(${claimed || "<empty>"}) does not match ${ledger.source} (${recordedValue || "<empty>"})`,
          );
        }
      }
    }
  }

  if (report.verdictBasis === "no-baseline") {
    issues.push(
      "benchmark evidence is incomplete: the report was rendered without a baseline, so its " +
        "verdict is inconclusive by construction and states nothing about a regression",
    );
  } else if (verdict === "inconclusive") {
    issues.push(
      "benchmark evidence is inconclusive: the run produced no verdict the evidence supports" +
        reasonSuffix(report.reasons),
    );
  } else if (verdict === "regressed") {
    issues.push(`benchmark evidence reports a regression${reasonSuffix(report.reasons)}`);
  }

  if (issues.length > 0) return blocked(issues, verdict);
  return { ok: true, status: "ok", report_state: view.state, verdict, issues: [] };
}

/** The report's own reasons, as one trailing clause. Bounded: a gate line is read, not scrolled. */
function reasonSuffix(reasons: unknown): string {
  if (!Array.isArray(reasons) || reasons.length === 0) return "";
  const listed = reasons.slice(0, 3).map((reason) => String(reason));
  const rest = reasons.length - listed.length;
  return `: ${listed.join("; ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}
