// VQ-501 (5/5-a) testai — diegimo/valdymo komandų handleriai per fake portus: project-mode
// eilutės ir --json, preflight exit kontraktas (pass → 0, kita → 1, klaida → 2),
// restore-stable plano/vykdymo skirtis (be --execute niekas nevykdoma), smoke ataskaita su
// AG_SMOKE_* žyme ir install skip-if-exists elgesys su šablonų versijos būsena.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { PreflightDecision, PreflightPorts } from "../application/quality-gates/preflight.js";
import type { ProjectModeDetectionPorts } from "../application/project-bootstrap/detect-mode.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import { projectModeCommand } from "../interfaces/cli/bootstrap/project-mode.js";
import { preflightCommand } from "../interfaces/cli/bootstrap/preflight.js";
import {
  restoreStable,
  restoreStableCommand,
  type RestoreStablePorts,
} from "../interfaces/cli/bootstrap/restore-stable.js";
import { smokeCommand, type SmokePorts } from "../interfaces/cli/bootstrap/smoke.js";
import {
  describeTemplateVersionStatus,
  installCommand,
  installTemplates,
  type InstallPorts,
  type TemplateEntry,
} from "../interfaces/cli/bootstrap/install.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

// ---------------------------------------------------------------------------
// project-mode
// ---------------------------------------------------------------------------

const EMPTY_MODE_PORTS: ProjectModeDetectionPorts = {
  exists: async () => false,
  findProductMarkers: async () => [],
  findSourceFiles: async () => [],
  countMarkdownFiles: async () => 0,
  listSubdirectories: async () => [],
  listFiles: async () => [],
  readTextFileIfExists: async () => undefined,
};

test("projectModeCommand: tekstinės eilutės ir --json ta pati detekcija", async () => {
  const ports: ProjectModeDetectionPorts = {
    ...EMPTY_MODE_PORTS,
    exists: async (p) => rel(p) === "AG",
    findProductMarkers: async () => ["package.json"],
    countMarkdownFiles: async (dir) => (rel(dir) === "AG/tasks/queue" ? 3 : 0),
  };

  const text = captureIo();
  const exit = await projectModeCommand(
    { ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: text.io },
    [],
  );
  assert.equal(exit, 0);
  assert.equal(text.out[0], "project-mode: extend_project");
  assert.equal(text.out[1], "confidence: high");
  assert.ok(text.out.includes("queued_tasks: 3"));
  assert.ok(text.out.includes("product_markers: 1"));

  const json = captureIo();
  assert.equal(
    await projectModeCommand({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: json.io }, ["--json"]),
    0,
  );
  const detection = JSON.parse(json.out.join("\n")) as { mode: string; signals: { queuedTasks: number } };
  assert.equal(detection.mode, "extend_project");
  assert.equal(detection.signals.queuedTasks, 3);
});

test("projectModeCommand: portų klaida — 2 be pusinės ataskaitos", async () => {
  const ports: ProjectModeDetectionPorts = {
    ...EMPTY_MODE_PORTS,
    findProductMarkers: async () => {
      throw new Error("skenas neprieinamas");
    },
  };
  const { io, out, err } = captureIo();
  assert.equal(await projectModeCommand({ ports, projectRoot: ROOT, io }, []), 2);
  assert.equal(out.length, 0);
  assert.equal(err[0], "skenas neprieinamas");
});

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

const UNUSED_PREFLIGHT_PORTS: PreflightPorts = {
  resolveTaskFile: async () => {
    throw new Error("resolveTaskFile neturi būti kviestas");
  },
  loadPolicies: async () => {
    throw new Error("loadPolicies neturi būti kviestas");
  },
  statPathKind: async () => "absent",
  codeIndexFreshness: async () => ({ ok: true }),
  writeDecision: async () => {},
};

function decision(overrides: Partial<PreflightDecision> = {}): PreflightDecision {
  return {
    task_id: "0042",
    verdict: "pass",
    reasons: [],
    allowed_files: ["src/x.ts"],
    checks: ["pnpm test"],
    spec_sources: [],
    metrics: { lines: 20, allowedPaths: 1, domains: 1, actionBullets: 2, domainNames: ["src"] },
    token_budget: {
      tier: "medium",
      max_context_chars: 12000,
      max_files: 8,
      max_spec_fragments: 8,
      max_file_fragments: 8,
      model_policy_hint: "sonnet",
      max_turns: 40,
      reasons: [],
    },
    ...overrides,
  };
}

test("preflightCommand: pass → 0 su biudžeto eilutėmis, review-needed → 1 su vartais", async () => {
  const pass = captureIo();
  assert.equal(
    await preflightCommand(
      { ports: UNUSED_PREFLIGHT_PORTS, projectRoot: ROOT, evaluate: async () => decision(), io: pass.io },
      ["0042.md"],
    ),
    0,
  );
  assert.equal(pass.out[0], "preflight: pass");
  assert.ok(pass.out.includes("token_budget: medium"));
  assert.ok(pass.out.includes("token_budget_model_hint: sonnet"));

  const review = captureIo();
  const reviewDecision = decision({
    verdict: "review-needed",
    reasons: ["broad scope"],
    classification: {
      categories: ["architecture"],
      sensitivity: "high",
      model_policy_hint: "opus",
      review_routing_hints: ["supervisor"],
      reasons: [],
    },
    human_review: {
      requires_human_review: true,
      gates: [{ category: "security", reason: "broad", evidence: [] }],
      reasons: [],
    },
  });
  assert.equal(
    await preflightCommand(
      { ports: UNUSED_PREFLIGHT_PORTS, projectRoot: ROOT, evaluate: async () => reviewDecision, io: review.io },
      ["0042.md"],
    ),
    1,
  );
  assert.equal(review.out[0], "preflight: review-needed");
  assert.ok(review.out.includes("classification: architecture (high)"));
  assert.ok(review.out.includes("model_hint: opus"));
  assert.ok(review.out.includes("review_hint: supervisor"));
  assert.ok(review.out.includes("human_review_gate: security"));
  assert.ok(review.out.includes("reason: broad scope"));
});

test("preflightCommand: use case meta klaidą — 2; split planas spausdinamas dalimis", async () => {
  const failed = captureIo();
  assert.equal(
    await preflightCommand(
      {
        ports: UNUSED_PREFLIGHT_PORTS,
        projectRoot: ROOT,
        evaluate: async () => {
          throw new Error("Usage: verqestra preflight <task-file>");
        },
        io: failed.io,
      },
      [],
    ),
    2,
  );
  assert.equal(failed.err[0], "Usage: verqestra preflight <task-file>");

  const split = captureIo();
  const splitDecision = decision({
    verdict: "invalid",
    split_plan: {
      required: true,
      reason: ["too large"],
      parent_task_id: "0042",
      first_task: "0042-a",
      child_tasks: [],
      parts: 3,
    },
  });
  assert.equal(
    await preflightCommand(
      { ports: UNUSED_PREFLIGHT_PORTS, projectRoot: ROOT, evaluate: async () => splitDecision, io: split.io },
      ["0042.md"],
    ),
    1,
  );
  assert.ok(split.out.includes("split_plan: 3 parts"));
});

// ---------------------------------------------------------------------------
// restore-stable
// ---------------------------------------------------------------------------

function restorePorts(overrides: Partial<RestoreStablePorts> = {}): RestoreStablePorts {
  return {
    loadStableRef: async () => ({ status: "ok", ref: "a".repeat(40) }),
    runGit: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...overrides,
  };
}

test("restoreStable: be --execute tik planas — git nekviečiamas", async () => {
  let gitCalls = 0;
  const ports = restorePorts({
    runGit: async () => {
      gitCalls += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const { io, out } = captureIo();
  const exit = await restoreStableCommand({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, []);

  assert.equal(exit, 0);
  assert.equal(gitCalls, 0, "planas niekada neliečia darbinio medžio");
  assert.ok(out[0]?.startsWith("Planned recovery: git -C "));
  assert.equal(out[1], "No files changed. Re-run with --execute to apply it.");
});

test("restoreStable: --execute vykdo reset ir raportuoja ref; skaitomas vq/state/stable-ref", async () => {
  let seenPath = "";
  let seenArgs: string[] = [];
  const ports = restorePorts({
    loadStableRef: async (p) => {
      seenPath = rel(p);
      return { status: "ok", ref: "b".repeat(40) };
    },
    runGit: async (args) => {
      seenArgs = args;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const { io, out } = captureIo();
  const exit = await restoreStableCommand({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, ["--execute"]);

  assert.equal(exit, 0);
  assert.equal(seenPath, "vq/state/stable-ref");
  assert.deepEqual(seenArgs, ["reset", "--hard", "b".repeat(40)]);
  assert.equal(out[0], `Restored stable reference: ${"b".repeat(40)}`);
});

test("restoreStable: trūkstamas ref, nežinomas argumentas ir git klaida — 1 su žinute", async () => {
  const missing = captureIo();
  const missingPorts = restorePorts({
    loadStableRef: async () => ({ status: "missing", message: "Stable reference is missing" }),
  });
  assert.equal(await restoreStableCommand({ ports: missingPorts, projectRoot: ROOT, io: missing.io }, []), 1);
  assert.equal(missing.err[0], "Stable reference is missing");

  const unknown = await restoreStable({ ports: restorePorts(), projectRoot: ROOT }, ["--force"]);
  assert.deepEqual(unknown, { status: "failed", message: "Unknown restore-stable option: --force" });

  const failedGit = captureIo();
  const failingPorts = restorePorts({
    runGit: async () => ({ code: 1, stdout: "", stderr: "fatal: bad object" }),
  });
  assert.equal(
    await restoreStableCommand({ ports: failingPorts, projectRoot: ROOT, io: failedGit.io }, ["--execute"]),
    1,
  );
  assert.equal(failedGit.err[0], "fatal: bad object");
});

// ---------------------------------------------------------------------------
// smoke
// ---------------------------------------------------------------------------

const CLI_ENTRY = path.join(ROOT, "dist", "cli.js");

const HEALTHY_PATHS = [
  "vq/config/commands.env",
  "vq/config/models.env",
  "dist/cli.js",
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/rules/agents.md",
  ".claude/rules/workflow.md",
  ".claude/rules/constraints.md",
  "AG/tasks/queue",
  "AG/tasks/active",
  "AG/tasks/done",
  "AG/tasks/human-review",
  "vq/supervisor",
  "vq/logs",
  "vq/state",
  ".claude/agents",
];

function smokePorts(overrides: Partial<SmokePorts> = {}, present: string[] = HEALTHY_PATHS): SmokePorts {
  const existing = new Set(present);
  return {
    ensureDirs: async () => {},
    commandExists: async () => true,
    exists: async (p) => existing.has(rel(p)),
    readTextFileIfExists: async (p) =>
      rel(p) === ".claude/settings.json" ? "{}" : rel(p) === "vq/state/stable-ref" ? `${"c".repeat(40)}\n` : undefined,
    countMarkdownFiles: async () => 0,
    isGitRepository: async () => true,
    gitCommitExists: async () => true,
    ...overrides,
  };
}

test("smokeCommand: sveikas diegimas — AG_SMOKE_OK, exit 0", async () => {
  const { io, out } = captureIo();
  const exit = await smokeCommand({ ports: smokePorts(), projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, cliEntry: CLI_ENTRY, io });

  assert.equal(exit, 0);
  assert.equal(out.at(-1), "AG_SMOKE_OK");
  assert.ok(out.includes("OK   active task directory is empty"));
  assert.ok(out.includes("OK   stable-ref"));
  // Keliai spausdinami platformos separatoriumi — lyginam normalizuotai.
  assert.ok(out.map(norm).includes("OK   file: vq/config/models.env"));
  assert.ok(out.map(norm).includes("OK   dir: AG/tasks/queue"));
  assert.equal(out.filter((line) => line.startsWith("FAIL")).length, 0);
});

test("smokeCommand: trūkstamas konfigas, blogas settings JSON ir negaliojantis ref — AG_SMOKE_FAILED", async () => {
  const present = HEALTHY_PATHS.filter((entry) => entry !== "vq/config/models.env");
  const ports = smokePorts(
    {
      readTextFileIfExists: async (p) =>
        rel(p) === ".claude/settings.json" ? "{ not json" : rel(p) === "vq/state/stable-ref" ? "deadbeef\n" : undefined,
      gitCommitExists: async () => false,
      countMarkdownFiles: async () => 2,
    },
    present,
  );
  const { io, out } = captureIo();
  const exit = await smokeCommand({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, cliEntry: CLI_ENTRY, io });

  assert.equal(exit, 1);
  assert.equal(out.at(-1), "AG_SMOKE_FAILED");
  assert.ok(out.includes("FAIL .claude/settings.json syntax"));
  assert.ok(out.includes("FAIL stable-ref is not a valid commit"));
  assert.ok(out.includes("WARN active task directory contains 2 task file(s)"));
});

test("smokeCommand: nesamas stable-ref yra WARN, ne FAIL — kilpa dar nepadarė checkpoint'o", async () => {
  const ports = smokePorts({
    readTextFileIfExists: async (p) => (rel(p) === ".claude/settings.json" ? "{}" : undefined),
    gitCommitExists: async () => {
      throw new Error("git neturi būti kviečiamas be ref");
    },
  });
  const { io, out } = captureIo();
  assert.equal(
    await smokeCommand({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, cliEntry: CLI_ENTRY, io }),
    0,
  );
  assert.ok(out.includes("WARN stable-ref missing"));
  assert.equal(out.at(-1), "AG_SMOKE_OK");
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const TEMPLATES_ROOT = path.resolve("/pkg/templates");

const TEMPLATE_ENTRIES: TemplateEntry[] = [
  { relativePath: ".claude", kind: "directory" },
  { relativePath: path.join(".claude", "settings.json"), kind: "file" },
  { relativePath: "CLAUDE.md", kind: "file" },
];

function installPorts(input: {
  existing?: string[];
  templateVersion?: string;
  installedVersion?: string;
}): { ports: InstallPorts; copies: string[]; directories: string[] } {
  const existing = new Set(input.existing ?? []);
  const copies: string[] = [];
  const directories: string[] = [];
  const ports: InstallPorts = {
    listTemplateEntries: async () => TEMPLATE_ENTRIES,
    exists: async (p) => existing.has(rel(p)),
    makeDirectory: async (dir) => void directories.push(rel(dir)),
    copyFile: async (_source, target) => void copies.push(rel(target)),
    readTextFileIfExists: async (p) => {
      if (norm(p) === norm(path.join(TEMPLATES_ROOT, "VERSION"))) return input.templateVersion;
      if (rel(p) === "VERSION") return input.installedVersion;
      return undefined;
    },
  };
  return { ports, copies, directories };
}

test("installTemplates: esamas failas praleidžiamas, naujas kopijuojamas; --dry-run nieko nerašo", async () => {
  const live = installPorts({ existing: [".claude"] });
  const result = await installTemplates(live.ports, ROOT, TEMPLATES_ROOT, false);
  assert.deepEqual(result.createdDirectories, []);
  assert.deepEqual(result.copiedFiles, [".claude/settings.json", "CLAUDE.md"]);
  assert.deepEqual(result.skippedFiles, []);
  assert.equal(live.copies.length, 2);

  const dry = installPorts({ existing: [".claude", "CLAUDE.md"] });
  const dryResult = await installTemplates(dry.ports, ROOT, TEMPLATES_ROOT, true);
  assert.deepEqual(dryResult.copiedFiles, [".claude/settings.json"]);
  assert.deepEqual(dryResult.skippedFiles, ["CLAUDE.md"]);
  assert.equal(dry.copies.length, 0, "--dry-run niekada nerašo");
  assert.equal(dry.directories.length, 0);
});

test("describeTemplateVersionStatus: be VERSION — null; atsilikusi versija mini išsaugotus failus", async () => {
  const none = installPorts({});
  assert.equal(await describeTemplateVersionStatus(none.ports, TEMPLATES_ROOT, ROOT, false), null);

  const fresh = installPorts({ templateVersion: "1.4.0\n" });
  assert.equal(await describeTemplateVersionStatus(fresh.ports, TEMPLATES_ROOT, ROOT, true), "Template version: 1.4.0");

  const behind = installPorts({ templateVersion: "1.4.0", installedVersion: "1.2.0" });
  assert.equal(
    await describeTemplateVersionStatus(behind.ports, TEMPLATES_ROOT, ROOT, false),
    "Template version: installed 1.2.0, current 1.4.0 — behind current 1.4.0 (existing files were preserved; review template changes)",
  );

  const current = installPorts({ templateVersion: "1.4.0", installedVersion: "1.4.0" });
  assert.match(
    (await describeTemplateVersionStatus(current.ports, TEMPLATES_ROOT, ROOT, false)) ?? "",
    /up to date$/,
  );
});

function installDeps(ports: InstallPorts, io: CliIo) {
  return { ports, templatesRoot: TEMPLATES_ROOT, projectRoot: ROOT, io };
}

test("installCommand: eilutės su prefiksu, blogi argumentai ir sugadinta versija — 2", async () => {
  const live = installPorts({ existing: ["CLAUDE.md"], templateVersion: "1.4.0" });
  const ok = captureIo();
  assert.equal(await installCommand(installDeps(live.ports, ok.io), [ROOT]), 0);
  assert.ok(ok.out.includes("Wrote directory: .claude"));
  assert.ok(ok.out.includes("Wrote file: .claude/settings.json"));
  assert.ok(ok.out.includes("Skipped existing file: CLAUDE.md"));
  assert.equal(ok.out.at(-1), "Template version: 1.4.0");

  const usage = captureIo();
  assert.equal(await installCommand(installDeps(live.ports, usage.io), [ROOT, "extra"]), 2);
  assert.match(usage.err[0] ?? "", /^Usage: verqestra install /);

  const broken = installPorts({ existing: [], templateVersion: "v1" });
  const invalid = captureIo();
  assert.equal(await installCommand(installDeps(broken.ports, invalid.io), [ROOT, "--dry-run"]), 2);
  assert.match(invalid.err[0] ?? "", /Invalid template version "v1"/);
});

test("installCommand: be pozicinio argumento diegia į deps.projectRoot", async () => {
  const live = installPorts({ existing: ["CLAUDE.md"], templateVersion: "1.4.0" });
  const ok = captureIo();
  assert.equal(await installCommand(installDeps(live.ports, ok.io), []), 0);
  assert.ok(ok.out.includes("Wrote directory: .claude"));
  assert.ok(ok.out.includes("Skipped existing file: CLAUDE.md"));

  const dryRunOnly = captureIo();
  assert.equal(await installCommand(installDeps(live.ports, dryRunOnly.io), ["--dry-run"]), 0);
  assert.ok(dryRunOnly.out.some((line) => line.startsWith("Would write")));
});
