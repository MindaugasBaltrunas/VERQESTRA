// VQ-305 (3/3-c): benchmark raporto skaitytojo (BENCH-10/11), provenance (BENCH-17) ir
// BENCH-12 release vartų unit testai per fake BenchmarkFsPort. Jokio realaus FS/git.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  readBenchmarkReportView,
  BENCHMARK_REPORT_RELATIVE_PATH,
  MAX_BENCHMARK_REPORT_BYTES,
  type BenchmarkFsPort,
} from "../application/benchmark/suite-report-view.js";
import {
  countLedgerSamples,
  readSuiteLockHash,
  BENCHMARK_SAMPLE_LEDGER_RELATIVE_PATH,
  BENCHMARK_SUITE_LOCK_RELATIVE_PATH,
} from "../application/benchmark/report-provenance.js";
import {
  checkBenchmarkEvidence,
  describeBenchmarkEvidence,
} from "../application/release-readiness/benchmark-evidence-check.js";

const ROOT = path.resolve("/repo");
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
  };
}

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
  const ledger = (content: string) => fakeFs({ [abs(BENCHMARK_SAMPLE_LEDGER_RELATIVE_PATH)]: { kind: "file", content } });
  assert.equal((await countLedgerSamples(ledger('{"a":1}\n{"b":2}\n'), ROOT)).count, 2);
  assert.match((await countLedgerSamples(ledger('{"a":1}\n{"b"'), ROOT)).problem ?? "", /ends mid-record/);
  assert.match((await countLedgerSamples(ledger('{"a":1}\n\n{"b":2}\n'), ROOT)).problem ?? "", /blank line at record 2/);
  assert.match((await countLedgerSamples(ledger("ne json\n"), ROOT)).problem ?? "", /unreadable record at line 1/);
});

function evidenceFs(input: { report?: string; lockHash?: string; ledgerLines?: number }): BenchmarkFsPort {
  const entries: Record<string, FakeEntry> = packageWith({});
  if (input.report !== undefined) entries[abs(BENCHMARK_REPORT_RELATIVE_PATH)] = { kind: "file", content: input.report };
  if (input.lockHash !== undefined) {
    entries[abs(BENCHMARK_SUITE_LOCK_RELATIVE_PATH)] = { kind: "file", content: JSON.stringify({ suiteHash: input.lockHash }) };
  }
  if (input.ledgerLines !== undefined) {
    entries[abs(BENCHMARK_SAMPLE_LEDGER_RELATIVE_PATH)] = {
      kind: "file",
      content: Array.from({ length: input.ledgerLines }, (_, index) => `{"sample":${index}}`).join("\n") + (input.ledgerLines > 0 ? "\n" : ""),
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
