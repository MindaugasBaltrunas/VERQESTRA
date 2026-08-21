// VQ-501 (4/5-a) testai — auditų klasterio CLI handleriai per fake portus: exit
// kontraktai (converged/ok/complete → 0, likutis → 1, klaida/unknown-arg → 2), etalono
// console eilutės, readiness writeResult persist, learning record/summary/approve kelias.
// VQ-501 (4/5-c) papildymas — audit-director: iteracijų ciklas (žalia/raudona/limitas),
// raporto turinys, agento promptas iš įrašyto raporto ir komandų politikos 126 kelias.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { ConvergePorts } from "../application/release-readiness/converge-check.js";
import type {
  ReadinessAuditResult,
  ReadinessPorts,
} from "../application/release-readiness/readiness-audit.js";
import type { BacklogAuditPorts } from "../application/release-readiness/backlog-audit.js";
import type { FinalAuditPorts, FinalAuditResult } from "../application/release-readiness/final-audit.js";
import type { ReleaseNotesPorts } from "../application/release-readiness/release-notes.js";
import { securityPolicySchema } from "../application/policy-governance/security-spec-policies.js";
import type { SecurityVerifyPorts } from "../application/quality-gates/security-verify.js";
import type { LearningFsPort } from "../application/learning/ports.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import { convergeCommand } from "../interfaces/cli/audit/converge.js";
import { readinessAuditCommand } from "../interfaces/cli/audit/readiness-audit.js";
import { backlogAuditCommand } from "../interfaces/cli/audit/backlog-audit.js";
import { finalAuditCommand, renderFinalAudit } from "../interfaces/cli/audit/final-audit.js";
import { securityVerifyCommand } from "../interfaces/cli/audit/security-verify.js";
import { releaseNotesCommand } from "../interfaces/cli/audit/release-notes.js";
import { learningCommand } from "../interfaces/cli/audit/learning.js";
import { EMPTY_CHECK_COMMAND_CONTEXT } from "../domain/policies/check-command-allowlist.js";
import { qualityPolicySchema, type QualityPolicy } from "../application/policy-governance/quality-policy.js";
import {
  auditDirectorCommand,
  auditReportPath,
  type AuditDirectorPorts,
} from "../interfaces/cli/audit/audit-director.js";

const ROOT = path.resolve("/repo");
const norm = (p: string): string => p.replace(/\\/g, "/");

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

// ---------------------------------------------------------------------------
// converge / readiness / backlog
// ---------------------------------------------------------------------------

// Statuso failų mtime turi egzistuoti: converge stale-status vartas tikrina juos
// BESĄLYGIŠKAI, tad `undefined` mtime tuščiame pasaulyje reikštų "issues".
const emptyConvergePorts: ConvergePorts = {
  readTextFileIfExists: async () => undefined,
  listSubdirectories: async () => [],
  listFiles: async () => [],
  fileMtimeMs: async () => 1,
};

test("convergeCommand: tuščias pasaulis su šviežiais status failais — converged, exit 0", async () => {
  const { io, out } = captureIo();
  const exit = await convergeCommand({ ports: emptyConvergePorts, projectRoot: ROOT, io }, []);
  assert.equal(exit, 0);
  const result = JSON.parse(out.join("\n")) as { status: string; issues: unknown[] };
  assert.equal(result.status, "converged");
  assert.deepEqual(result.issues, []);
});

test("convergeCommand: trūkstami status failai — stale-status issues ir exit 1", async () => {
  const { io, out } = captureIo();
  const ports: ConvergePorts = { ...emptyConvergePorts, fileMtimeMs: async () => undefined };
  const exit = await convergeCommand({ ports, projectRoot: ROOT, io }, []);
  assert.equal(exit, 1);
  const result = JSON.parse(out.join("\n")) as { status: string; issues: Array<{ kind: string }> };
  assert.equal(result.status, "issues");
  assert.ok(result.issues.every((issue) => issue.kind === "stale-status"));
  assert.ok(result.issues.length > 0);
});

function readinessPorts(kinds: Map<string, "file" | "directory">): ReadinessPorts {
  return {
    statKind: async (p) => kinds.get(norm(p)) ?? "absent",
    readTextFileIfExists: async () => undefined,
  };
}

const READINESS_REQUIREMENTS = {
  folders: ["AG/tasks"],
  configs: [],
  tests: [],
  docs: [],
  commandSources: [],
} as const;

test("readinessAuditCommand: ok kelias persistina rezultatą, missing → 1, unknown arg → 2", async () => {
  const kinds = new Map<string, "file" | "directory">([[norm(path.join(ROOT, "AG/tasks")), "directory"]]);
  const written: ReadinessAuditResult[] = [];
  const deps = {
    ports: readinessPorts(kinds),
    requirements: READINESS_REQUIREMENTS,
    projectRoot: ROOT,
    writeResult: async (result: ReadinessAuditResult) => {
      written.push(result);
    },
  };
  const { io, out } = captureIo();
  assert.equal(await readinessAuditCommand({ ...deps, io }, []), 0);
  assert.ok(out[0]?.startsWith("Readiness audit: ok"));
  assert.equal(written.length, 1);

  const { io: io2, out: out2 } = captureIo();
  const missingDeps = { ...deps, ports: readinessPorts(new Map()), io: io2 };
  assert.equal(await readinessAuditCommand(missingDeps, []), 1);
  assert.ok(out2[0]?.startsWith("Readiness audit: not_ready"));
  assert.ok(out2.join("\n").includes("folders: missing (missing: AG/tasks)"));

  const { io: io3, err } = captureIo();
  assert.equal(await readinessAuditCommand({ ...deps, io: io3 }, ["--foo"]), 2);
  assert.equal(err[0], "Unknown readiness-audit argument: --foo");
});

test("backlogAuditCommand: tuščias backlog'as — incomplete exit 1, unknown arg → 2", async () => {
  const ports: BacklogAuditPorts = {
    listFiles: async () => [],
    readTextFileIfExists: async () => undefined,
  };
  const { io, out } = captureIo();
  assert.equal(await backlogAuditCommand({ ports, projectRoot: ROOT, io }, []), 1);
  assert.equal(out[0]?.split("\n")[0], "Backlog audit: incomplete");
  assert.ok(out[0]?.includes("Tasks: 0"));

  const { io: io2, err } = captureIo();
  assert.equal(await backlogAuditCommand({ ports, projectRoot: ROOT, io: io2 }, ["--x"]), 2);
  assert.equal(err[0], "Unknown backlog-audit argument: --x");
});

// ---------------------------------------------------------------------------
// final-audit
// ---------------------------------------------------------------------------

function unusedFinalAuditPorts(overrides: Partial<FinalAuditPorts> = {}): FinalAuditPorts {
  const boom = (): never => {
    throw new Error("unexpected port call");
  };
  return {
    listBucketFiles: async () => boom(),
    humanReviewResolved: async () => boom(),
    converge: async () => boom(),
    readiness: async () => boom(),
    backlog: async () => boom(),
    readReleaseCheck: async () => boom(),
    newestMtime: async () => boom(),
    newestMtimeInDir: async () => boom(),
    policyFs: { readTextFileIfExists: async () => boom() },
    sourceFs: {
      listFilesRecursive: async () => boom(),
      exists: async () => boom(),
      readTextFile: async () => boom(),
      readTextFileIfExists: async () => boom(),
    },
    pendingProposalCount: async () => boom(),
    architectureBoundary: async () => boom(),
    benchmarkEvidence: async () => boom(),
    compressionQuality: async () => boom(),
    releaseNotes: async () => boom(),
    releaseProof: async () => boom(),
    writeReport: async () => boom(),
    ...overrides,
  };
}

test("finalAuditCommand: unknown arg atmetamas prieš portų kvietimą, klaida → 2", async () => {
  const { io, err } = captureIo();
  const deps = { ports: unusedFinalAuditPorts(), projectRoot: ROOT, io };
  assert.equal(await finalAuditCommand(deps, ["--foo"]), 2);
  assert.equal(err[0], "Unknown final-audit argument: --foo");

  const { io: io2, err: err2 } = captureIo();
  const failing = unusedFinalAuditPorts({
    listBucketFiles: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(await finalAuditCommand({ ports: failing, projectRoot: ROOT, io: io2 }, []), 2);
  assert.equal(err2[0], "boom");
});

test("renderFinalAudit: etalono eilutės su checks/notes/proof", () => {
  const result: FinalAuditResult = {
    status: "not_complete",
    pending_tasks: {},
    checks: {
      converge: { ok: true, issues: [] },
      backlog: { ok: false, issues: ["missing-category:testing"] },
    },
    release_notes: { status: "generated", path: "docs/RELEASE_NOTES.md", done_tasks: 3, release_check_status: "ok" },
    report_path: "vq/state/final-audit-result.json",
    updated_at: "t",
  };
  assert.equal(
    renderFinalAudit(result),
    [
      "Final audit: not_complete",
      "Report: vq/state/final-audit-result.json",
      "converge: ok",
      "backlog: not_ok (missing-category:testing)",
      "Release notes: generated docs/RELEASE_NOTES.md",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// security-verify / release-notes
// ---------------------------------------------------------------------------

test("securityVerifyCommand: radinys blokuoja (exit 1), eilutės etalono formos", async () => {
  const ports: SecurityVerifyPorts = {
    loadPolicy: async () => securityPolicySchema.parse({ dangerous_code_patterns: ["eval"] }),
    changedFiles: async () => ["src/a.ts"],
    readTextFile: async () => 'eval("x");\n',
    writeResult: async () => {},
  };
  const { io, out } = captureIo();
  const exit = await securityVerifyCommand({ ports, projectRoot: ROOT, io }, []);
  assert.equal(exit, 1);
  assert.deepEqual(out, ["security-verify: blocked", "files: 1", "blocked_paths: 0", "text_findings: 1"]);
});

test("releaseNotesCommand: disabled politika — eilutės ir exit 0", async () => {
  const ports: ReleaseNotesPorts = {
    loadPolicy: async () => ({ release_notes_after_final_audit: false, release_notes_path: "docs/RELEASE_NOTES.md" }),
    readTaskLedger: async () => ({}),
    readReleaseCheckStatus: async () => "missing",
    readProjectStatus: async () => "",
    writeNotes: async () => {},
  };
  const { io, out } = captureIo();
  assert.equal(await releaseNotesCommand({ ports, io }, []), 0);
  assert.deepEqual(out, [
    "release-notes: disabled",
    "path: docs/RELEASE_NOTES.md",
    "done_tasks: 0",
    "release_check_status: disabled",
  ]);
});

// ---------------------------------------------------------------------------
// learning
// ---------------------------------------------------------------------------

function learningFs(files: Map<string, string>): LearningFsPort {
  return {
    readTextFileIfExists: async (p) => files.get(norm(p)),
    appendTextFile: async (p, text) => {
      files.set(norm(p), (files.get(norm(p)) ?? "") + text);
    },
    writeTextFile: async (p, content) => {
      files.set(norm(p), content);
    },
    makeDirectory: async () => {},
  };
}

const RUNTIME_ROOT = path.join(ROOT, "vq");

test("learningCommand: record → summary → approve grandinė", async () => {
  const files = new Map<string, string>();
  const deps = { fs: learningFs(files), runtimeRoot: RUNTIME_ROOT };

  const { io: ioRec, out: outRec } = captureIo();
  const exitRec = await learningCommand({ ...deps, io: ioRec }, [
    "record",
    "--type",
    "policy_recommendation",
    "--summary",
    "kelti limitą",
  ]);
  assert.equal(exitRec, 0);
  assert.match(outRec[0] ?? "", /^learning_record: /);
  const recordId = (outRec[0] ?? "").replace("learning_record: ", "");
  assert.ok(files.has(norm(path.join(RUNTIME_ROOT, "state", "learning", "events.jsonl"))));

  const { io: ioSum, out: outSum } = captureIo();
  assert.equal(await learningCommand({ ...deps, io: ioSum }, ["summary"]), 0);
  assert.equal(outSum[0], "records: 1");
  assert.equal(outSum[4], "policy_recommendation: 1");
  assert.equal(outSum[5], "pending_recommendations: 1");

  const { io: ioApp, out: outApp } = captureIo();
  assert.equal(await learningCommand({ ...deps, io: ioApp }, ["approve", recordId]), 0);
  assert.equal(outApp[0], `learning_recommendation_approved: ${recordId}`);

  const { io: ioSum2, out: outSum2 } = captureIo();
  assert.equal(await learningCommand({ ...deps, io: ioSum2 }, ["summary"]), 0);
  assert.equal(outSum2[6], "approved_recommendations: 1");
});

test("learningCommand: query filtruoja pagal task-id, klaidų keliai → 2", async () => {
  const files = new Map<string, string>();
  const deps = { fs: learningFs(files), runtimeRoot: RUNTIME_ROOT };
  await learningCommand({ ...deps, io: captureIo().io }, ["record", "--type", "task_outcome", "--summary", "ok", "--task-id", "0042"]);
  await learningCommand({ ...deps, io: captureIo().io }, ["record", "--type", "task_outcome", "--summary", "kitas", "--task-id", "0099"]);

  const { io, out } = captureIo();
  assert.equal(await learningCommand({ ...deps, io }, ["query", "--task-id", "0042"]), 0);
  assert.equal(out.length, 1);
  assert.ok(out[0]?.endsWith(": ok"));

  const { io: ioBad, err } = captureIo();
  assert.equal(await learningCommand({ ...deps, io: ioBad }, ["record", "--summary", "be tipo"]), 2);
  assert.equal(err[0], "--type is required");

  const { io: ioUnk, err: errUnk } = captureIo();
  assert.equal(await learningCommand({ ...deps, io: ioUnk }, ["frobnicate"]), 2);
  assert.match(errUnk[0] ?? "", /^Usage: ag learning /);

  const { io: ioApp, err: errApp } = captureIo();
  assert.equal(await learningCommand({ ...deps, io: ioApp }, ["approve"]), 2);
  assert.match(errApp[0] ?? "", /^Usage: ag learning approve /);
});

// ---------------------------------------------------------------------------
// audit-director (VQ-501 4/5-c)
// ---------------------------------------------------------------------------

const AUDIT_POLICY = qualityPolicySchema.parse({
  task: { checks: ["pnpm typecheck", { cmd: "pnpm", args: ["test"] }] },
  feature: { checks: [] },
  milestone: { checks: [] },
});

type AuditWorld = {
  ports: AuditDirectorPorts;
  files: Map<string, string>;
  logs: string[];
  prompts: { prompt: string; model: string }[];
};

function auditWorld(options: {
  codes: number[][];
  auditExit?: number;
  policy?: QualityPolicy;
}): AuditWorld {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const prompts: { prompt: string; model: string }[] = [];
  let iteration = 0;

  const ports: AuditDirectorPorts = {
    ensureDirs: async () => {},
    loadPolicy: async () => options.policy ?? AUDIT_POLICY,
    commandContext: async () => EMPTY_CHECK_COMMAND_CONTEXT,
    runner: async (check) => {
      const round = options.codes[Math.min(iteration, options.codes.length - 1)] ?? [];
      const index = check.display === "pnpm typecheck" ? 0 : 1;
      return { code: round[index] ?? 0, stdout: `${check.display} išvestis`, stderr: "" };
    },
    writeTextFile: async (p, content) => {
      files.set(norm(p), content);
    },
    readTextFileIfExists: async (p) => files.get(norm(p)),
    resolveModel: async (tier) => `claude-${tier}-5`,
    runAudit: async (prompt, model) => {
      prompts.push({ prompt, model });
      iteration += 1;
      return options.auditExit ?? 0;
    },
    agLog: async (line) => {
      logs.push(line);
    },
    now: () => new Date("2026-08-21T00:00:00.000Z"),
  };

  return { ports, files, logs, prompts };
}

test("auditDirectorCommand: žalios patikros pirmoje iteracijoje — 0, raportas įrašytas, agentas nekviestas", async () => {
  const world = auditWorld({ codes: [[0, 0]] });
  const { io, out } = captureIo();
  const exit = await auditDirectorCommand({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io });

  assert.equal(exit, 0);
  assert.equal(world.prompts.length, 0);
  assert.ok(out.includes("AUDIT ✅ — visos patikros praeina"));
  assert.ok(world.logs.includes("AUDIT PASSED"));

  const report = world.files.get(norm(auditReportPath(RUNTIME_ROOT))) ?? "";
  assert.ok(report.startsWith("# Audit Report — iteracija 1"));
  assert.ok(report.includes("- praeina: task-1, task-2"));
  assert.ok(report.includes("- nepraėjo: nė vienas"));
});

test("auditDirectorCommand: raudona pirma iteracija, žalia antra — agentas kviestas su raporto tekstu", async () => {
  const world = auditWorld({ codes: [[1, 0], [0, 0]] });
  const { io, out } = captureIo();
  const exit = await auditDirectorCommand({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io });

  assert.equal(exit, 0);
  assert.equal(world.prompts.length, 1);
  assert.equal(world.prompts[0]?.model, "claude-sonnet-5");
  assert.ok(world.prompts[0]?.prompt.startsWith("# Audit Director — iteracija 1"));
  // Agentas gauna TĄ raportą, kuris ką tik įrašytas — ne tuščią promptą.
  assert.ok(world.prompts[0]?.prompt.includes("❌ NEPRAĖJO (exit 1)"));
  assert.ok(out.some((line) => line.startsWith("Nepraėjo: task-1 — raportas: ")));
});

test("auditDirectorCommand: nuolat raudona — iteracijų limitas, exit 1", async () => {
  const world = auditWorld({ codes: [[1, 1]] });
  const { io, out } = captureIo();
  const exit = await auditDirectorCommand({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io });

  assert.equal(exit, 1);
  assert.equal(world.prompts.length, 2);
  assert.ok(out.includes("AUDIT ❌ — iteracijų limitas (3) pasiektas"));
  assert.ok(world.logs.includes("AUDIT FAILED: max iterations reached"));
});

test("auditDirectorCommand: agento paleidimo klaida propaguojama, o politikos atmesta patikra — 126 raporte", async () => {
  const launchFailure = auditWorld({ codes: [[1, 1]], auditExit: 127 });
  const { io } = captureIo();
  const exit = await auditDirectorCommand({
    ports: launchFailure.ports,
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });
  assert.equal(exit, 127);
  assert.equal(launchFailure.prompts.length, 1);

  // Ta pati komandų politika kaip quality-gates: `rm -rf` neprasprūsta antru vykdymo keliu.
  const blockedPolicy = qualityPolicySchema.parse({
    task: { checks: ["rm -rf dist"] },
    feature: { checks: [] },
    milestone: { checks: [] },
  });
  const blocked = auditWorld({ codes: [[0]], policy: blockedPolicy });
  const { io: blockedIo } = captureIo();
  const blockedExit = await auditDirectorCommand({
    ports: blocked.ports,
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io: blockedIo,
  });
  assert.equal(blockedExit, 1);
  const report = blocked.files.get(norm(auditReportPath(RUNTIME_ROOT))) ?? "";
  assert.ok(report.includes("exit 126"));
  assert.ok(report.includes("Audit check blocked by shell policy"));
});
