// VQ-305 (3/3-c): benchmark raporto skaitytojo (BENCH-10/11), provenance (BENCH-17) ir
// BENCH-12 release vartų unit testai per fake BenchmarkFsPort. Jokio realaus FS/git.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  readBenchmarkReportView,
  BENCHMARK_PACKAGE_RELATIVE_PATH,
  BENCHMARK_REPORT_RELATIVE_PATH,
  MAX_BENCHMARK_REPORT_BYTES,
  type BenchmarkFsPort,
} from "../application/benchmark/suite-report-view.js";
import {
  countLedgerSamples,
  readSuiteLockHash,
  BENCHMARK_RUN_LEDGER_DIRECTORY,
  BENCHMARK_SUITE_LOCK_RELATIVE_PATH,
} from "../application/benchmark/report-provenance.js";
import {
  checkBenchmarkEvidence,
  describeBenchmarkEvidence,
} from "../application/release-readiness/benchmark-evidence-check.js";

const ROOT = path.resolve("/repo");

const LF = "\n";
const abs = (relative: string): string => path.join(ROOT, ...relative.split("/")).replace(/\\/g, "/");

type FakeEntry = { kind: "file" | "directory" | "other"; content?: string; size?: number };

function fakeFs(entries: Record<string, FakeEntry>): BenchmarkFsPort {
  const map = new Map(Object.entries(entries));
  const norm = (p: string) => p.replace(/\\/g, "/");
  return {
    statPath: async (p) => {
      const entry = map.get(norm(p));
      if (!entry) return { kind: "absent", size: 0 };
      return { kind: entry.kind, size: entry.size ?? (entry.content ?? "").length };
    },
    readTextFile: async (p) => {
      const entry = map.get(norm(p));
      if (!entry || entry.content === undefined) throw new Error(`ENOENT: ${p}`);
      return entry.content;
    },
    listDirectory: async (dir) => {
      const prefix = `${norm(dir)}/`;
      return [...map.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
        .map((key) => key.slice(prefix.length))
        .sort();
    },
  };
}

/** Kelias iki run ledger'io; vardo forma yra kontraktas, tad testas jos nesugalvoja laisvai. */
const runLedger = (stamp: string): string => `${BENCHMARK_RUN_LEDGER_DIRECTORY}/run-${stamp}.jsonl`;

/** Vienos ledger'io eilutės identifikuojantis minimumas — tiek, kiek vartai apie sample'ą žino. */
const sampleLine = (mode: string, repetition: number): string =>
  JSON.stringify({
    sampleId: `scenario-${mode}-r${repetition}`,
    scenarioId: "bugfix-i18n-missing-key",
    mode,
    repetition,
    telemetry: { model: "claude-opus-5", inputTokens: 1, outputTokens: 1, llmCalls: 1 },
  });

const FULL_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

function reportDoc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    verdict: "stable",
    verdictBasis: "comparison",
    reasons: [],
    current: { identity: { suiteHash: "suite-1", configHash: "", policyHash: "", agCommit: FULL_SHA }, sampleCount: 2 },
    modes: [],
    scenarios: [],
    limitations: [],
    reproduction: { command: "pnpm --dir AG/benchmark benchmark:report" },
    ...overrides,
  });
}

function packageWith(entries: Record<string, FakeEntry>): Record<string, FakeEntry> {
  return { [abs("AG/benchmark")]: { kind: "directory" }, ...entries };
}

test("suite-report-view: missing/corrupt klasifikacija be turinio aido", async () => {
  const noPackage = await readBenchmarkReportView(fakeFs({}), { projectRoot: ROOT });
  assert.equal(noPackage.state, "missing");
  assert.match(noPackage.reason ?? "", /is not part of this installation/);

  const noReport = await readBenchmarkReportView(fakeFs(packageWith({})), { projectRoot: ROOT });
  assert.equal(noReport.state, "missing");
  assert.match(noReport.reason ?? "", /does not exist\. Generated reports are not committed/);

  const symlinkish = await readBenchmarkReportView(
    fakeFs(packageWith({ [abs(BENCHMARK_REPORT_RELATIVE_PATH)]: { kind: "other" } })),
    { projectRoot: ROOT },
  );
  assert.equal(symlinkish.state, "corrupt");
  assert.match(symlinkish.reason ?? "", /never through a link/);

  const oversized = await readBenchmarkReportView(
    fakeFs(packageWith({ [abs(BENCHMARK_REPORT_RELATIVE_PATH)]: { kind: "file", content: "{}", size: MAX_BENCHMARK_REPORT_BYTES + 1 } })),
    { projectRoot: ROOT },
  );
  assert.equal(oversized.state, "corrupt");

  const badJson = await readBenchmarkReportView(
    fakeFs(packageWith({ [abs(BENCHMARK_REPORT_RELATIVE_PATH)]: { kind: "file", content: "{SLAPTAS-TURINYS" } })),
    { projectRoot: ROOT },
  );
  assert.equal(badJson.state, "corrupt");
  assert.doesNotMatch(badJson.reason ?? "", /SLAPTAS/, "parserio tekstas niekada neaidimas");

  const badSchema = await readBenchmarkReportView(
    fakeFs(packageWith({ [abs(BENCHMARK_REPORT_RELATIVE_PATH)]: { kind: "file", content: '{"verdict":"stable"}' } })),
    { projectRoot: ROOT },
  );
  assert.equal(badSchema.state, "corrupt");
  assert.match(badSchema.reason ?? "", /is not a benchmark report/);

  const wrongVersion = await readBenchmarkReportView(
    fakeFs(packageWith({ [abs(BENCHMARK_REPORT_RELATIVE_PATH)]: { kind: "file", content: reportDoc({ schemaVersion: 9 }) } })),
    { projectRoot: ROOT },
  );
  assert.equal(wrongVersion.state, "corrupt");
  assert.match(wrongVersion.reason ?? "", /declares schemaVersion 9/);
});

test("suite-report-view: staleness — tuščias commit, kito commit'o raportas, prefix match", async () => {
  const emptyCommit = await readBenchmarkReportView(
    fakeFs(packageWith({
      [abs(BENCHMARK_REPORT_RELATIVE_PATH)]: {
        kind: "file",
        content: reportDoc({ current: { identity: { suiteHash: "s", configHash: "", policyHash: "", agCommit: "" }, sampleCount: 1 } }),
      },
    })),
    { projectRoot: ROOT, currentAgCommit: async () => FULL_SHA },
  );
  assert.equal(emptyCommit.state, "stale");
  assert.ok(emptyCommit.report, "stale raportas vis tiek serviruojamas");

  const mismatch = await readBenchmarkReportView(
    fakeFs(packageWith({ [abs(BENCHMARK_REPORT_RELATIVE_PATH)]: { kind: "file", content: reportDoc() } })),
    { projectRoot: ROOT, currentAgCommit: async () => "ffffffffffff" },
  );
  assert.equal(mismatch.state, "stale");
  assert.match(mismatch.reason ?? "", /was measured on AG commit/);
  // 2026-08-26: commit-mismatch vaistas yra NAUJAS MATAVIMAS, ne raporto persigeneravimas —
  // `benchmark:report` įrašyto agCommit pakeisti negali, tad jo siūlymas čia buvo neveiksmingas
  // patarimas (operatorius jį paleisdavo, banner'is likdavo).
  assert.match(mismatch.reason ?? "", /benchmark run --allow-network/);
  assert.doesNotMatch(mismatch.reason ?? "", /benchmark:report/, "report komanda lieka vaistu tik missing atvejui");

  // Sutrumpintas SHA (>=7) atitinka pilną — prefix taisyklė.
  const prefix = await readBenchmarkReportView(
    fakeFs(packageWith({
      [abs(BENCHMARK_REPORT_RELATIVE_PATH)]: {
        kind: "file",
        content: reportDoc({ current: { identity: { suiteHash: "s", configHash: "", policyHash: "", agCommit: FULL_SHA.slice(0, 12) }, sampleCount: 1 } }),
      },
    })),
    { projectRoot: ROOT, currentAgCommit: async () => FULL_SHA },
  );
  assert.equal(prefix.state, "available");

  // Be resolverio freshness patikra praleidžiama — raportas available, currentAgCommit undefined.
  const skipped = await readBenchmarkReportView(
    fakeFs(packageWith({ [abs(BENCHMARK_REPORT_RELATIVE_PATH)]: { kind: "file", content: reportDoc() } })),
    { projectRoot: ROOT },
  );
  assert.equal(skipped.state, "available");
  assert.equal(skipped.freshness.currentAgCommit, undefined);
});

test("report-provenance: suite lock ir ledger skaitymo matricos", async () => {
  assert.match((await readSuiteLockHash(fakeFs({}), ROOT)).problem ?? "", /does not exist/);
  assert.match(
    (await readSuiteLockHash(fakeFs({ [abs(BENCHMARK_SUITE_LOCK_RELATIVE_PATH)]: { kind: "file", content: "{" } }), ROOT)).problem ?? "",
    /not valid JSON/,
  );
  assert.match(
    (await readSuiteLockHash(fakeFs({ [abs(BENCHMARK_SUITE_LOCK_RELATIVE_PATH)]: { kind: "file", content: "{}" } }), ROOT)).problem ?? "",
    /non-empty suiteHash/,
  );
  assert.equal(
    (await readSuiteLockHash(fakeFs({ [abs(BENCHMARK_SUITE_LOCK_RELATIVE_PATH)]: { kind: "file", content: '{"suiteHash":"suite-1"}' } }), ROOT)).hash,
    "suite-1",
  );

  assert.equal((await countLedgerSamples(fakeFs({}), ROOT)).count, 0, "nesamas ledger'is = 0 sample'ų");
  const ledger = (content: string) =>
    fakeFs({ [abs(runLedger("20260822t141440313z"))]: { kind: "file", content } });
  const one = sampleLine("ag-loop", 1);
  const two = sampleLine("agent-solo", 1);
  assert.equal((await countLedgerSamples(ledger(`${one}${LF}${two}${LF}`), ROOT)).count, 2);
  assert.match((await countLedgerSamples(ledger(`${one}${LF}{"b"`), ROOT)).problem ?? "", /ends mid-record/);
  assert.match(
    (await countLedgerSamples(ledger(`${one}${LF}${LF}${two}${LF}`), ROOT)).problem ?? "",
    /blank line at record 2/,
  );
  assert.match((await countLedgerSamples(ledger(`ne json${LF}`), ROOT)).problem ?? "", /unreadable record at line 1/);
});

/**
 * Bet koks JSON objektas NĖRA sample'as.
 *
 * Skaitiklis skaičiavo sėkmingus `JSON.parse`, tad ledger'is iš devyniasdešimt devynių `{"a":1}`
 * eilučių atsakydavo „devyniasdešimt devyni sample'ai" ir atitikdavo raportą, teigiantį tiek pat.
 * Oficialus skaitytojas (`readAuthoritativeSamples`) kiekvieną iš jų atmestų — vartai buvo
 * griežtai SILPNESNI už įrankį, kurio išvestį jie tikrina. Tai vienintelė kryptis, kuria patikra
 * negali būti silpnesnė.
 */
test("BENCH-12 provenance: eilutė, kuri nėra sample'as, nėra suskaičiuojama", async () => {
  const ledger = (content: string) =>
    fakeFs({ [abs(runLedger("20260822t141440313z"))]: { kind: "file", content } });

  const forged = `{"a":1}${LF}`.repeat(99);
  const counted = await countLedgerSamples(ledger(forged), ROOT);
  assert.equal(counted.count, undefined, "99 objektų nėra 99 sample'ai");
  assert.match(counted.problem ?? "", /line 1 that is not a stored sample/);

  // Kiekvienas identifikuojantis laukas yra būtinas: praradus bet kurį, įrašas nustoja būti tuo,
  // kuo apsimeta.
  for (const missing of ["sampleId", "scenarioId", "mode", "repetition", "telemetry"]) {
    const record = JSON.parse(sampleLine("ag-loop", 1)) as Record<string, unknown>;
    delete record[missing];
    const result = await countLedgerSamples(ledger(`${JSON.stringify(record)}${LF}`), ROOT);
    assert.equal(result.count, undefined, `be "${missing}" įrašas vis dar praėjo`);
  }

  // Ir skaičiuojama pagal režimą, ne tik bendra suma: suma yra pakartojimu klastojama.
  const mixed = `${sampleLine("ag-loop", 1)}${LF}${sampleLine("ag-loop", 2)}${LF}${sampleLine("agent-solo", 1)}${LF}`;
  const tally = await countLedgerSamples(ledger(mixed), ROOT);
  assert.equal(tally.count, 3);
  assert.equal(tally.perMode.get("ag-loop"), 2);
  assert.equal(tally.perMode.get("agent-solo"), 1);
});

/**
 * The gate must read the ledger the benchmark package actually writes.
 *
 * It did not. The package moved to one file per run (`results/runs/run-<ts>.jsonl`) and the gate
 * stayed on the single `results/samples.jsonl` it was written against. Because an absent ledger
 * counts as zero samples, the mismatch never surfaced as an error — it silently blocked every
 * report claiming any sample at all, reporting that the ledger held none. Two checks stand
 * against that returning: the newest of several run ledgers must be the one counted, and neither
 * the `.unmeasured.jsonl` sidecar beside it nor a fabricated legacy `samples.jsonl` may answer in
 * its place.
 */
test("BENCH-12 provenance: vartai skaito TIKRĄ run ledger'į, ne pasenusį kelią", async () => {
  const newest = runLedger("20260822t141440313z");
  const older = runLedger("20260101t000000000z");
  const record = (...records: readonly string[]): string =>
    records.map((json) => `${json}${LF}`).join("");
  const fs = fakeFs({
    [abs(older)]: { kind: "file", content: record(sampleLine("ag-loop", 1)) },
    [abs(newest)]: {
      kind: "file",
      content: record(sampleLine("ag-loop", 1), sampleLine("ag-loop", 2), sampleLine("agent-solo", 1)),
    },
    // Šalutinis pėdsakas, gulintis TAME PAČIAME kataloge: jo įrašai yra prarastos celės, ne
    // sample'ai. Suskaičiavus juos, run'as atrodytų pilnesnis, kuo daugiau jo nepavyko.
    [abs(`${BENCHMARK_RUN_LEDGER_DIRECTORY}/run-20260822t141440313z.unmeasured.jsonl`)]: {
      kind: "file",
      content: record('{"lost":1}', '{"lost":2}'),
    },
    // Pasenęs kelias, kurio paketas nebeturi ir nebeprirašo.
    [abs(`${BENCHMARK_PACKAGE_RELATIVE_PATH}/results/samples.jsonl`)]: {
      kind: "file",
      content: record(...Array.from({ length: 99 }, () => sampleLine("ag-loop", 1))),
    },
  });

  const counted = await countLedgerSamples(fs, ROOT);
  assert.equal(counted.count, 3, "naujausias run'as yra didžiausias vardas, ne pirmas ir ne senas kelias");
  assert.equal(counted.source, newest, "vartai privalo pasakyti, KURĮ ledger'į skaitė");
});

test("BENCH-12 provenance: be nė vieno run'o skaičius yra nulis, o šaltinio nėra", async () => {
  const empty = await countLedgerSamples(fakeFs({}), ROOT);
  assert.equal(empty.count, 0);
  assert.equal(empty.source, undefined, "šaltinis negali būti įvardytas, kai jo nėra");
});

/**
 * Tapatybė, kurią `reportDoc` skelbia. Sidecar'as ir raportas normaliame kelyje sutampa, nes
 * raportas savo tapatybę ima BŪTENT iš įrašo — tad testas, kuriame jie skiriasi, yra testas apie
 * raportą, atsilikusį nuo ledger'io.
 */
const RECORDED_IDENTITY: {
  suiteHash: string;
  configHash: string;
  policyHash: string;
  agCommit: string;
} = {
  suiteHash: "suite-1",
  configHash: "",
  policyHash: "",
  agCommit: FULL_SHA,
};

const LEDGER_STAMP = "20260822t141440313z";

function evidenceFs(input: {
  report?: string;
  lockHash?: string;
  ledgerLines?: number;
  sidecar?: Partial<typeof RECORDED_IDENTITY> | "absent";
}): BenchmarkFsPort {
  const entries: Record<string, FakeEntry> = packageWith({});
  if (input.report !== undefined) entries[abs(BENCHMARK_REPORT_RELATIVE_PATH)] = { kind: "file", content: input.report };
  if (input.lockHash !== undefined) {
    entries[abs(BENCHMARK_SUITE_LOCK_RELATIVE_PATH)] = { kind: "file", content: JSON.stringify({ suiteHash: input.lockHash }) };
  }
  if (input.ledgerLines !== undefined) {
    if (input.sidecar !== "absent") {
      entries[abs(`${BENCHMARK_RUN_LEDGER_DIRECTORY}/run-${LEDGER_STAMP}.identity.json`)] = {
        kind: "file",
        content: JSON.stringify({ identity: { ...RECORDED_IDENTITY, ...input.sidecar } }),
      };
    }
    entries[abs(runLedger(LEDGER_STAMP))] = {
      kind: "file",
      content: Array.from({ length: input.ledgerLines }, (_, index) => sampleLine("agent-solo", index + 1))
        .map((line) => `${line}${LF}`)
        .join(""),
    };
  }
  return fakeFs(entries);
}

const HEAD = async (): Promise<string> => FULL_SHA;

test("BENCH-12 vartai: not_applicable be paketo; ok tik šviežiam, atribuotam, ne-regresavusiam raportui", async () => {
  const notInstalled = await checkBenchmarkEvidence(fakeFs({}), ROOT);
  assert.deepEqual(notInstalled, { ok: true, status: "not_applicable", report_state: "not_installed", issues: [] });
  assert.match(describeBenchmarkEvidence(notInstalled), /not_applicable/);

  const ok = await checkBenchmarkEvidence(
    evidenceFs({ report: reportDoc(), lockHash: "suite-1", ledgerLines: 2 }),
    ROOT,
    { currentAgCommit: HEAD },
  );
  assert.equal(ok.ok, true, ok.issues.join("; "));
  assert.equal(ok.verdict, "stable");
  assert.equal(describeBenchmarkEvidence(ok), "ok (stable)");

  const missing = await checkBenchmarkEvidence(evidenceFs({}), ROOT, { currentAgCommit: HEAD });
  assert.equal(missing.ok, false);
  assert.match(missing.issues[0] ?? "", /benchmark evidence is missing/);

  const stale = await checkBenchmarkEvidence(
    evidenceFs({ report: reportDoc(), lockHash: "suite-1", ledgerLines: 2 }),
    ROOT,
    { currentAgCommit: async () => "ffffffffffff" },
  );
  assert.equal(stale.ok, false);
  assert.match(stale.issues[0] ?? "", /benchmark evidence is stale/);
});

test("BENCH-12 vartai: atribucijos ir verdikto blokai kaupiasi su tiksliomis priežastimis", async () => {
  const hashMismatch = await checkBenchmarkEvidence(
    evidenceFs({ report: reportDoc(), lockHash: "KITAS", ledgerLines: 2 }),
    ROOT,
    { currentAgCommit: HEAD },
  );
  assert.equal(hashMismatch.ok, false);
  assert.ok(hashMismatch.issues.some((issue) => issue.includes("does not match the tracked suite")));

  const countMismatch = await checkBenchmarkEvidence(
    evidenceFs({ report: reportDoc(), lockHash: "suite-1", ledgerLines: 5 }),
    ROOT,
    { currentAgCommit: HEAD },
  );
  assert.ok(countMismatch.issues.some((issue) => issue.includes("claims 2 sample(s)") && issue.includes("holds 5")));

  const zeroSamples = await checkBenchmarkEvidence(
    evidenceFs({
      report: reportDoc({ current: { identity: { suiteHash: "suite-1", configHash: "", policyHash: "", agCommit: FULL_SHA }, sampleCount: 0 } }),
      lockHash: "suite-1",
      ledgerLines: 0,
    }),
    ROOT,
    { currentAgCommit: HEAD },
  );
  assert.ok(zeroSamples.issues.some((issue) => issue.includes("covers 0 samples")));

  const noBaseline = await checkBenchmarkEvidence(
    evidenceFs({ report: reportDoc({ verdictBasis: "no-baseline" }), lockHash: "suite-1", ledgerLines: 2 }),
    ROOT,
    { currentAgCommit: HEAD },
  );
  assert.ok(noBaseline.issues.some((issue) => issue.includes("rendered without a baseline")));

  const inconclusive = await checkBenchmarkEvidence(
    evidenceFs({ report: reportDoc({ verdict: "inconclusive", reasons: ["r1", "r2", "r3", "r4"] }), lockHash: "suite-1", ledgerLines: 2 }),
    ROOT,
    { currentAgCommit: HEAD },
  );
  assert.ok(inconclusive.issues.some((issue) => issue.includes("inconclusive") && issue.includes("(+1 more)")));

  const regressed = await checkBenchmarkEvidence(
    evidenceFs({ report: reportDoc({ verdict: "regressed", reasons: ["p95 blogiau"] }), lockHash: "suite-1", ledgerLines: 2 }),
    ROOT,
    { currentAgCommit: HEAD },
  );
  assert.ok(regressed.issues.some((issue) => issue.includes("reports a regression: p95 blogiau")));
  assert.match(describeBenchmarkEvidence(regressed), /^blocked: /);
});

/**
 * Raportas privalo aprašyti TĄ paleidimą, kurio ledger'is suskaičiuotas.
 *
 * `suiteHash` prieš `suite.lock.json` atsako į kitą klausimą — ar tai apskritai tracked rinkinys.
 * Jis nieko nesako apie tai, KURIS paleidimas pagamino skaičius, ir su vienu ledger'iu per run'ą
 * tai nustojo būti smulkmena: `reports/` gitignore'intas ir generuojamas rankiniu paleidimu, o
 * ledger'is pasikeičia po kiekvieno run'o. Sugeneruok raportą iš A, paleisk B — `suiteHash`
 * sutampa, `sampleCount` gali sutapti, ir vartai praleistų raportą apie kitą paleidimą.
 */
test("BENCH-12 vartai: raportas, aprašantis kitą paleidimą, blokuojamas", async () => {
  const drifted = await checkBenchmarkEvidence(
    evidenceFs({
      report: reportDoc(),
      lockHash: "suite-1",
      ledgerLines: 2,
      // Tas pats rinkinys, tas pats sample'ų skaičius, KITA konfigūracija ir kitas commit'as:
      // tiksliai tai, ką duoda raportas, atsilikęs per vieną paleidimą.
      sidecar: { configHash: "sha256:kita-konfiguracija", agCommit: "b".repeat(40) },
    }),
    ROOT,
    { currentAgCommit: HEAD },
  );

  assert.equal(drifted.ok, false, "sutampantis suiteHash ir sampleCount nedaro raporto atribuotinu");
  const issues = drifted.issues.join("\n");
  assert.match(issues, /describes another run: the report's configHash/);
  assert.match(issues, /describes another run: the report's agCommit/);
  // Įvardijamas ledger'is, su kuriuo lyginta — kitaip skaitytojas nežino, kur žiūrėti.
  assert.match(issues, /run-20260822t141440313z\.jsonl/);
});

test("BENCH-12 vartai: legacy ledger'is be sidecar'o praleidžiamas, sugadintas — ne", async () => {
  // Ledger'is, rašytas prieš atsirandant įrašui, yra vienintelis atvejis, kurį galima praleisti:
  // jų atmetimas iškart padarytų kiekvieną saugomą run'ą nepatikrinamą.
  const legacy = await checkBenchmarkEvidence(
    evidenceFs({ report: reportDoc(), lockHash: "suite-1", ledgerLines: 2, sidecar: "absent" }),
    ROOT,
    { currentAgCommit: HEAD },
  );
  assert.equal(legacy.ok, true, "nesantis įrašas nėra neatitikimas");

  // Bet įrašas, kuris EGZISTUOJA ir neperskaitomas, yra: run'as, pasakęs savo tapatybę ir
  // nebegalintis jos pakartoti, nėra įrodymas, kuriam ką nors galima priskirti.
  const damagedFs = fakeFs({
    ...packageWith({}),
    [abs(BENCHMARK_REPORT_RELATIVE_PATH)]: { kind: "file", content: reportDoc() },
    [abs(BENCHMARK_SUITE_LOCK_RELATIVE_PATH)]: { kind: "file", content: JSON.stringify({ suiteHash: "suite-1" }) },
    [abs(runLedger(LEDGER_STAMP))]: {
      kind: "file",
      content: `${sampleLine("agent-solo", 1)}${LF}${sampleLine("agent-solo", 2)}${LF}`,
    },
    [abs(`${BENCHMARK_RUN_LEDGER_DIRECTORY}/run-${LEDGER_STAMP}.identity.json`)]: {
      kind: "file",
      content: "{ ne json",
    },
  });
  const damaged = await checkBenchmarkEvidence(damagedFs, ROOT, { currentAgCommit: HEAD });
  assert.equal(damaged.ok, false);
  assert.match(damaged.issues.join("\n"), /run identity could not be read .*is not valid JSON/);
});
