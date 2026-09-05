// VQ-305 (3/3-b): release-readiness klasterio unit testai — milestone/release-check
// kompozicijos, source-state hash, README nuorodų vartas, git-automation fail-closed
// politika, release notes/proof ir final-audit kompozicija per fake portus. Jokio realaus FS.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { extractRelativeMarkdownLinks } from "../shared/markdown.js";
import {
  defaultGitAutomationPolicy,
  enforceCommitTitlePolicy,
  loadGitAutomationPolicy,
} from "../application/policy-governance/git-automation-policy.js";
import { runMilestoneCheck, type MilestoneCheckRunners } from "../application/release-readiness/milestone-check.js";
import {
  computeSourceState,
  findBrokenReadmeLinks,
  runReleaseCheck,
  type ReleaseCheckFsPort,
  type ReleaseCheckRunners,
} from "../application/release-readiness/release-check.js";
import { generateReleaseNotes, renderReleaseNotes } from "../application/release-readiness/release-notes.js";
import {
  checkReleaseProofFreshness,
  generateReleaseProof,
  renderReleaseProofMarkdown,
  type ReleaseProofData,
  type ReleaseProofPorts,
} from "../application/release-readiness/release-proof.js";
import { runFinalAudit, type FinalAuditPorts } from "../application/release-readiness/final-audit.js";
import type { QualityGatesStatus } from "../application/quality-gates/quality-gates-status.js";
import type { SecurityVerifyResult } from "../application/quality-gates/security-verify.js";
import type { SpecDriftResult } from "../application/quality-gates/spec-drift.js";

test("extractRelativeMarkdownLinks: lokalūs keliai be schemų, anchor'ų ir title'ų", () => {
  const md = [
    "[doc](doc/architecture/README.md)",
    "[ext](https://example.com/x)",
    "[anchor](#skyrius)",
    '[titled](docs/release.md "Release")',
    "[fragment](docs/release.md#gates)",
    "[wrapped](<docs/spaced path.md>)",
    "[dup](doc/architecture/README.md)",
  ].join("\n");
  assert.deepEqual(extractRelativeMarkdownLinks(md), [
    "doc/architecture/README.md",
    "docs/release.md",
    "docs/spaced",
  ]);
});

function fakeConfigFs(files: Record<string, string>): { readTextFileIfExists: (p: string) => Promise<string | undefined> } {
  const map = new Map(Object.entries(files));
  return { readTextFileIfExists: async (p) => map.get(p.replace(/\\/g, "/")) };
}

test("git-automation-policy: default'ai, fail-closed blogam konfigui, kelio normalizacija", async () => {
  assert.deepEqual(await loadGitAutomationPolicy(fakeConfigFs({}), "/repo/vq"), defaultGitAutomationPolicy);

  const errors: string[] = [];
  const broken = await loadGitAutomationPolicy(
    fakeConfigFs({ "/repo/vq/config/git-automation-policy.json": "{ blogas" }),
    "/repo/vq",
    (message) => errors.push(message),
  );
  assert.equal(broken.auto_push_enabled, false, "fail-closed: push išjungtas");
  assert.equal(broken.auto_commit_enabled, true, "lokalus commit lieka — saugo darbą nuo rollback kaskados");
  assert.ok(broken.config_error);
  assert.equal(errors.length, 1);

  const coerced = await loadGitAutomationPolicy(
    fakeConfigFs({ "/repo/vq/config/git-automation-policy.json": '{"auto_push_enabled":"no"}' }),
    "/repo/vq",
    () => {},
  );
  assert.equal(coerced.auto_push_enabled, false, "ne-boolean reikšmė = fail-closed, ne koercija į true");

  const partial = await loadGitAutomationPolicy(
    fakeConfigFs({
      "/repo/vq/config/git-automation-policy.json": '{"auto_push_enabled":false,"release_notes_path":"../evil.md"}',
    }),
    "/repo/vq",
  );
  assert.equal(partial.auto_push_enabled, false);
  assert.equal(partial.release_notes_path, defaultGitAutomationPolicy.release_notes_path, "traversal kelias atmetamas");

  assert.equal(enforceCommitTitlePolicy("feat(core): x", ["src/a.ts"], defaultGitAutomationPolicy), "feat(core): x");
  assert.notEqual(
    enforceCommitTitlePolicy("laisvas tekstas", ["src/a.ts"], defaultGitAutomationPolicy),
    "laisvas tekstas",
    "nekonvencinis pavadinimas pakeičiamas failų kilmės pavadinimu",
  );
});

const GREEN_QUALITY: QualityGatesStatus = {
  passed: true,
  exit_code: 0,
  has_commands: true,
  scope: "milestone",
  commands: ["pnpm test"],
  skipped: [],
  failed_gates: [],
  results: [],
  updated_at: "2026-08-20T09:00:00Z",
};

const EMPTY_SECURITY: SecurityVerifyResult = {
  status: "blocked",
  files: [],
  blocked_paths: [],
  text_findings: [],
  warnings: ["no files provided and no changed files detected"],
  result_path: "vq/state/security-verify-result.json",
};

const OK_SPEC: SpecDriftResult = {
  change_id: "ch-1",
  status: "ok",
  scope: ["src/**"],
  files: ["src/a.ts"],
  outside_scope: [],
  warnings: [],
  result_path: "vq/state/spec-drift-result.json",
};

function milestoneRunners(overrides: Partial<MilestoneCheckRunners> = {}): MilestoneCheckRunners {
  return {
    quality: async () => GREEN_QUALITY,
    specAlignment: async () => OK_SPEC,
    localPolicy: async () => EMPTY_SECURITY,
    ...overrides,
  };
}

test("milestone-check: tuščias security skenas = skipped, ne failed; be aktyvaus change — spec skipped", async () => {
  const results: unknown[] = [];
  const ports = { activeChangeId: async () => "ch-1", writeResult: async (result: unknown) => void results.push(result) };
  const ok = await runMilestoneCheck(ports, milestoneRunners(), { now: new Date("2026-08-20T09:00:00Z") });
  assert.equal(ok.status, "ok");
  assert.equal(ok.local_policy.status, "skipped", "blocked be findings = tuščias scope");
  assert.equal(ok.spec_alignment.status, "ok");
  assert.equal(results.length, 1);

  const noChange = await runMilestoneCheck(
    { ...ports, activeChangeId: async () => undefined },
    milestoneRunners(),
  );
  assert.equal(noChange.spec_alignment.status, "skipped");

  const redQuality = await runMilestoneCheck(ports, milestoneRunners({ quality: async () => ({ ...GREEN_QUALITY, passed: false }) }));
  assert.equal(redQuality.status, "failed");
  assert.deepEqual(redQuality.failed_parts, ["quality"]);

  const realBlock = await runMilestoneCheck(
    ports,
    milestoneRunners({
      localPolicy: async () => ({ ...EMPTY_SECURITY, files: ["src/a.ts"], text_findings: [{ file: "src/a.ts", line: 1, pattern: "eval(", text: "eval" }] }),
    }),
  );
  assert.deepEqual(realBlock.failed_parts, ["local_policy"], "realus findings = failed");
});

// Windows `path.resolve("/repo")` prideda disko raidę — visi absoliutūs fixture keliai
// statomi per TĄ PATĮ resolved ROOT, kad prefix/exists palyginimai sutaptų abiejose OS.
const ROOT = path.resolve("/repo");
const abs = (relative: string): string => path.join(ROOT, relative).replace(/\\/g, "/");

function fakeReleaseFs(input: { files: Record<string, string> }): ReleaseCheckFsPort {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const files = new Map(Object.entries(input.files).map(([key, value]) => [norm(key), value]));
  return {
    listFilesRecursive: async (dir) => {
      const prefix = `${norm(dir)}/`;
      return [...files.keys()].filter((file) => file.startsWith(prefix));
    },
    exists: async (p) => files.has(norm(p)),
    readTextFile: async (p) => {
      const hit = files.get(norm(p));
      if (hit === undefined) throw new Error(`ENOENT: ${p}`);
      return hit;
    },
    readTextFileIfExists: async (p) => files.get(norm(p)),
  };
}

test("computeSourceState: deterministinis hash'as, jautrus turiniui, nejautrus enumeracijos tvarkai", async () => {
  const files = {
    [abs("src/a.ts")]: "const a = 1;",
    [abs("src/b/c.ts")]: "const c = 2;",
    [abs("package.json")]: "{}",
  };
  const first = await computeSourceState(fakeReleaseFs({ files }), ROOT);
  const second = await computeSourceState(fakeReleaseFs({ files }), ROOT);
  assert.equal(first.hash, second.hash);
  assert.equal(first.file_count, 3);

  const changed = await computeSourceState(fakeReleaseFs({ files: { ...files, [abs("src/a.ts")]: "const a = 9;" } }), ROOT);
  assert.notEqual(changed.hash, first.hash);
});

test("findBrokenReadmeLinks: trūkstamas README, sulaužyta nuoroda, žalias kelias", async () => {
  assert.deepEqual(await findBrokenReadmeLinks(fakeReleaseFs({ files: {} }), ROOT), [
    "required doc is missing or empty: README.md",
  ]);
  const broken = await findBrokenReadmeLinks(
    fakeReleaseFs({ files: { [abs("README.md")]: "[x](docs/nėra.md)\n[ok](src/a.ts)", [abs("src/a.ts")]: "x" } }),
    ROOT,
  );
  assert.deepEqual(broken, ["README.md links to a missing path: docs/nėra.md"]);
});

test("runReleaseCheck: dalių kompozicija ir failed_parts", async () => {
  const results: unknown[] = [];
  const fs = fakeReleaseFs({ files: { [abs("src/a.ts")]: "const a = 1;" } });
  const runners: ReleaseCheckRunners = {
    build: async () => ({ command: "pnpm build", exitCode: 0 }),
    tests: async () => ({ command: "pnpm test", exitCode: 1, issues: ["testai krito"] }),
    milestone: async (quality) => ({
      status: quality.passed ? "ok" : "failed",
      quality: { status: quality.passed ? "ok" : "failed", result: quality },
      spec_alignment: { status: "skipped" },
      local_policy: { status: "skipped", result: EMPTY_SECURITY },
      failed_parts: quality.passed ? [] : ["quality"],
      result_path: "vq/state/milestone-check-result.json",
      updated_at: "2026-08-20T09:00:00Z",
    }),
    docs: async () => ({ status: "ok", issues: [] }),
    packageLayout: async () => ({ status: "ok", issues: [] }),
  };
  const result = await runReleaseCheck(
    { fs, writeResult: async (value) => void results.push(value) },
    runners,
    { projectRoot: ROOT, now: new Date("2026-08-20T09:00:00Z") },
  );
  assert.equal(result.status, "failed");
  assert.deepEqual(result.failed_parts, ["tests", "milestone"], "raudoni testai numuša ir milestone kokybę");
  assert.equal(result.source_state.file_count, 1);
  assert.equal(results.length, 1);
});

test("release-notes: disabled politika ir generuotas rendinimas", async () => {
  const writes: [string, string][] = [];
  const basePorts = {
    loadPolicy: async () => ({ release_notes_after_final_audit: true, release_notes_path: "vq/project/release-notes.md" }),
    readTaskLedger: async () => ({
      "0002": { state: "done", task_name: "antras", updated_at: "2026-08-02" },
      "0001": { state: "done", task_name: "pirmas", updated_at: "2026-08-01" },
      "0003": { state: "human-review", task_name: "parkas" },
    }),
    readReleaseCheckStatus: async () => "ok",
    readProjectStatus: async () => "Statusas.",
    writeNotes: async (relativePath: string, text: string) => void writes.push([relativePath, text]),
  };
  const generated = await generateReleaseNotes(basePorts, new Date("2026-08-20T09:00:00Z"));
  assert.equal(generated.status, "generated");
  assert.equal(generated.done_tasks, 2);
  assert.match(writes[0]![1], /- 0001: pirmas\n- 0002: antras/, "done taskai rūšiuoti pagal updated_at");

  const disabled = await generateReleaseNotes({
    ...basePorts,
    loadPolicy: async () => ({ release_notes_after_final_audit: false, release_notes_path: "vq/project/release-notes.md" }),
  });
  assert.equal(disabled.status, "disabled");
  assert.equal(writes.length, 1, "disabled kelias nieko nerašo");

  assert.match(renderReleaseNotes("t", "ok", "", []), /- No done tasks recorded\./);
});

function makeProofPorts(input: { head?: string; queueCount?: number; summary?: ReleaseProofData }): {
  ports: ReleaseProofPorts;
  summaries: ReleaseProofData[];
  markdowns: string[];
} {
  const summaries: ReleaseProofData[] = [];
  const markdowns: string[] = [];
  const ports: ReleaseProofPorts = {
    gitHead: async () => input.head,
    countNumberedTasks: async (bucket) => (bucket === "queue" ? (input.queueCount ?? 0) : 0),
    writeSummary: async (data) => void summaries.push(data),
    writeMarkdown: async (text) => void markdowns.push(text),
    readSummary: async () => input.summary,
  };
  return { ports, summaries, markdowns };
}

test("release-proof: generavimas, rendinimas ir šviežumo matrica", async () => {
  const { ports, summaries, markdowns } = makeProofPorts({ head: "abc123", queueCount: 0 });
  const written = await generateReleaseProof(ports, {
    finalAuditStatus: "complete",
    convergeStatus: "converged",
    releaseCheckStatus: "ok",
    architectureBoundaryStatus: "ok (baseline debt: 0)",
    now: new Date("2026-08-20T09:00:00Z"),
  });
  assert.equal(written.data.git_sha, "abc123");
  assert.equal(summaries.length, 1);
  assert.match(markdowns[0]!, /- final-audit: complete/);
  assert.match(markdowns[0]!, /- benchmark-evidence: not_checked/);
  assert.match(renderReleaseProofMarkdown(written.data), /Git SHA: abc123/);

  const fresh = await checkReleaseProofFreshness(makeProofPorts({ queueCount: 0, summary: written.data }).ports, "abc123");
  assert.equal(fresh.stale, false);

  assert.equal((await checkReleaseProofFreshness(makeProofPorts({}).ports, "abc123")).stale, true, "trūkstamas proof");
  assert.equal(
    (await checkReleaseProofFreshness(makeProofPorts({ summary: { ...written.data, git_sha: "kitas" } }).ports, "abc123")).stale,
    true,
    "SHA nesutampa",
  );
  const queueDrift = await checkReleaseProofFreshness(
    makeProofPorts({ queueCount: 2, summary: written.data }).ports,
    "abc123",
  );
  assert.equal(queueDrift.stale, true, "necommit'inti queue pakeitimai daro proof'ą pasenusį");
  assert.match(queueDrift.reason ?? "", /queue task count/);
  assert.equal(fresh.gitShaCheck, "verified", "su HEAD SHA patikra realiai įvyko");
  assert.equal(fresh.gitShaCheckReason, undefined);
});

test("release-proof: be HEAD SHA patikra žymima 'skipped', o ne tyliai praleidžiama", async () => {
  const proof: ReleaseProofData = {
    git_sha: "abc123",
    generated_at: "2026-08-20T09:00:00.000Z",
    final_audit_status: "complete",
    converge_status: "converged",
    release_check_status: "ok",
    architecture_boundary_status: "ok",
    task_bucket_counts: { queue: 0, active: 0, delegated: 0, done: 0, "human-review": 0, error: 0, failed: 0 },
  };

  // Ne-git aplinka: SHA nėra su kuo lyginti. Verdiktas lieka fail-open (`stale: false`, kaip
  // `milestone-check` „skipped" dalis neįeina į `failed_parts`), bet praleidimas dabar yra
  // deklaruotas laukas, ne nematoma `if` šaka (pilnas auditas 2026-09-05, RR-1).
  const noSha = await checkReleaseProofFreshness(makeProofPorts({ queueCount: 0, summary: proof }).ports, undefined);
  assert.equal(noSha.stale, false, "praleista SHA patikra nedaro proof'o pasenusiu");
  assert.equal(noSha.gitShaCheck, "skipped");
  assert.equal(noSha.gitShaCheckReason, "git sha unavailable");

  // Praleidimas matomas ir tada, kai proof'as pasensta dėl KITOS priežasties.
  const alsoStale = await checkReleaseProofFreshness(
    makeProofPorts({ summary: { ...proof, final_audit_status: "not_complete" } }).ports,
    undefined,
  );
  assert.equal(alsoStale.stale, true);
  assert.equal(alsoStale.gitShaCheck, "skipped", "stale verdiktas neslepia, kad SHA nebuvo tikrintas");
});

function makeFinalAuditPorts(overrides: Partial<FinalAuditPorts> = {}): {
  ports: FinalAuditPorts;
  reports: unknown[];
} {
  const reports: unknown[] = [];
  const releaseCheckState = {
    status: "ok",
    updated_at: "2026-08-20T08:00:00.000Z",
    source_state: { hash: "SRC", file_count: 1 },
  };
  const ports: FinalAuditPorts = {
    listBucketFiles: async () => [],
    humanReviewResolved: async () => false,
    converge: async () => ({ issues: [] }),
    readiness: async () => ({ ok: true, issues: [] }),
    backlog: async () => ({ ok: true, issues: [] }),
    readReleaseCheck: async () => releaseCheckState,
    newestMtime: async () => undefined,
    newestMtimeInDir: async () => undefined,
    policyFs: fakeConfigFs({}),
    sourceFs: fakeReleaseFs({ files: {} }),
    pendingProposalCount: async () => 0,
    architectureBoundary: async () => ({ ok: true, new_violation_count: 0, baseline_violation_count: 0, issues: [] }),
    benchmarkEvidence: async () => ({ ok: true, issues: [], describe: "not_applicable (benchmark package not installed)" }),
    compressionQuality: async () => ({ ok: true, issues: [], describe: "vacuous (no flags enabled)" }),
    releaseNotes: async () => ({ status: "generated", path: "vq/project/release-notes.md", done_tasks: 1, release_check_status: "ok" }),
    releaseProof: async (options) => ({
      data: {
        git_sha: "abc",
        generated_at: "t",
        final_audit_status: options.finalAuditStatus,
        converge_status: options.convergeStatus,
        release_check_status: options.releaseCheckStatus,
        architecture_boundary_status: options.architectureBoundaryStatus ?? "not_checked",
        benchmark_evidence_status: options.benchmarkEvidenceStatus ?? "not_checked",
        compression_quality_status: options.compressionQualityStatus ?? "not_checked",
        task_bucket_counts: { queue: 0, active: 0, delegated: 0, error: 0, failed: 0, "human-review": 0, done: 0 },
      },
      summary_path: "vq/project/final-audit-summary.json",
      markdown_path: "vq/project/final-release-proof.md",
    }),
    writeReport: async (result) => void reports.push(result),
    ...overrides,
  };
  return { ports, reports };
}

const FINAL_AUDIT_OPTS = {
  projectRoot: ROOT,
  // Aiškus runtimeRoot be resolve — fakeConfigFs raktai (`/repo/vq/...`) statomi path.join
  // forma, tad loaderių keliai sutampa abiejose OS.
  runtimeRoot: "/repo/vq",
  now: new Date("2026-08-20T09:00:00.000Z"),
};

test("final-audit: visi vartai žali → complete, notes ir proof su describe eilutėmis", async () => {
  // source_state hash sutampa su fake FS (tuščias rinkinys) — perskaičiuojamas realiu keliu.
  const emptySourceState = await computeSourceState(fakeReleaseFs({ files: {} }), ROOT);
  const { ports, reports } = makeFinalAuditPorts({
    readReleaseCheck: async () => ({
      status: "ok",
      updated_at: "2026-08-20T08:00:00.000Z",
      source_state: emptySourceState,
    }),
  });
  const result = await runFinalAudit(ports, FINAL_AUDIT_OPTS);
  assert.equal(result.status, "complete", JSON.stringify(result.checks));
  assert.ok(result.release_notes);
  assert.equal(result.release_proof?.data.benchmark_evidence_status, "not_applicable (benchmark package not installed)");
  assert.equal(reports.length, 1);
});

test("final-audit: laukiantis task'as, resolved human-review filtras ir rule-status klaidos", async () => {
  const pendingPorts = makeFinalAuditPorts({
    listBucketFiles: async (bucket) =>
      bucket === "queue" ? [{ name: "0042-darbas.md", text: "# Task\n## Tikslas\nX" }] : [],
  });
  const pending = await runFinalAudit(pendingPorts.ports, FINAL_AUDIT_OPTS);
  assert.equal(pending.status, "not_complete");
  assert.deepEqual(pending.checks["queue_empty"]?.issues, ["queue/0042-darbas.md"]);
  assert.equal(pending.release_notes, undefined, "raudonas auditas notes negeneruoja");

  // Resolved human-review: failas lieka, bet neblokuoja nei queue_empty, nei converge.
  const resolvedPorts = makeFinalAuditPorts({
    listBucketFiles: async (bucket) =>
      bucket === "human-review" ? [{ name: "0007-parkas.md", text: "# Task\n## Tikslas\nX" }] : [],
    humanReviewResolved: async (taskId) => taskId === "0007-parkas",
    converge: async () => ({ issues: [{ kind: "incomplete-work", ref: "human-review/0007-parkas.md" }] }),
  });
  const resolved = await runFinalAudit(resolvedPorts.ports, FINAL_AUDIT_OPTS);
  assert.equal(resolved.checks["queue_empty"]?.ok, true);
  assert.equal(resolved.checks["converge"]?.ok, true);

  // rule-status: sugadintas policy failas + laukiantys proposal'ai.
  const rulePorts = makeFinalAuditPorts({
    policyFs: fakeConfigFs({ "/repo/vq/architecture/enforcement-policy.json": "{ blogas" }),
    pendingProposalCount: async () => 2,
  });
  const rules = await runFinalAudit(rulePorts.ports, FINAL_AUDIT_OPTS);
  assert.equal(rules.checks["rule_status"]?.ok, false);
  assert.ok(rules.checks["rule_status"]?.issues.some((issue) => issue.startsWith("enforcement-policy:")));
  assert.ok(rules.checks["rule_status"]?.issues.includes("unresolved-proposal:2"));

  // Šviežumas: source_state hash nesutampa su dabartiniu medžiu → stale.
  const stalePorts = makeFinalAuditPorts({
    readReleaseCheck: async () => ({
      status: "ok",
      updated_at: "2026-08-20T08:00:00.000Z",
      source_state: { hash: "SENAS", file_count: 1 },
    }),
  });
  const stale = await runFinalAudit(stalePorts.ports, FINAL_AUDIT_OPTS);
  assert.equal(stale.checks["release_check"]?.ok, false);
  assert.deepEqual(stale.checks["release_check"]?.issues, ["release-check-result is stale: source"]);
});

// 2026-08-22: `release-check` įrašė hash'ą su KOMPOZICIJOS įėjimų sąrašu, o `final-audit` jį
// tikrino su application default'u — du skirtingi „šaltinio" apibrėžimai, tad šviežumo patikra
// niekada nepraeidavo. Vartas, visada sakantis „stale", yra lygiai taip pat nenaudingas kaip
// visada sakantis „ok": abu nustoja nešti informaciją. Testas pin'ina, kad hash'as, įrašytas su
// TAIS PAČIAIS įėjimais, laikomas šviežiu, o su kitais — ne.
test("final-audit: šviežumas skaičiuojamas TAIS PAČIAIS įėjimais kaip release-check", async () => {
  const files = { [abs("src/a.ts")]: "const a = 1;", [abs("scripts/x.mjs")]: "export {};" };
  const inputs = { dirs: ["src"], files: ["package.json"] };
  const sourceState = await computeSourceState(fakeReleaseFs({ files }), ROOT, inputs);

  const ports = makeFinalAuditPorts({
    sourceFs: fakeReleaseFs({ files }),
    readReleaseCheck: async () => ({
      status: "ok",
      updated_at: "2026-08-20T08:00:00.000Z",
      source_state: sourceState,
    }),
  });

  const fresh = await runFinalAudit(ports.ports, { ...FINAL_AUDIT_OPTS, sourceStateInputs: inputs });
  assert.equal(fresh.checks["release_check"]?.ok, true, JSON.stringify(fresh.checks["release_check"]));

  // Kitas įėjimų sąrašas = kitas hash'as, net jei medis nepasikeitė nė per baitą.
  const mismatched = await runFinalAudit(ports.ports, {
    ...FINAL_AUDIT_OPTS,
    sourceStateInputs: { dirs: ["src", "scripts"], files: ["package.json"] },
  });
  assert.equal(mismatched.checks["release_check"]?.ok, false);
});
