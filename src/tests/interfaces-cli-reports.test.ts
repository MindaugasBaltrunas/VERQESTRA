// VQ-501 (4/5-b) testai — report ir project-status per fake portus: telemetrijos
// santraukos (griežtas token-usage parseris, grupavimas, rikiavimas), render eilučių
// paritetas, recent outcomes fallback į state-history, project-status failų rašymas su
// release proof missing sekcija ir aktyvia spec.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  parseTokenUsageSummaryLines,
  summarizeTokenUsage,
  summarizeTokenUsageByModel,
} from "../application/analytics/token-usage-summary.js";
import type { ReleaseProofPorts } from "../application/release-readiness/release-proof.js";
import type { ContextPackFileSystemPort } from "../application/context-pack/ports.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import {
  buildLocalTelemetryReport,
  reportCommand,
  type LocalTelemetryReport,
  type ReportCommandDeps,
} from "../interfaces/cli/reports/report.js";
import { projectStatusCommand, type ProjectStatusCommandDeps } from "../interfaces/cli/reports/project-status.js";

const ROOT = path.resolve("/repo");
const norm = (p: string): string => p.replace(/\\/g, "/");
const abs = (rel: string): string => norm(path.join(ROOT, rel));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

function makeContextFs(files: Map<string, string>): ContextPackFileSystemPort {
  return {
    readTextFileIfExists: async (p) => files.get(norm(p)),
    readFileBytes: async () => {
      throw new Error("ENOENT");
    },
    exists: async (p) => files.has(norm(p)),
    appendTextFile: async (p, text) => {
      files.set(norm(p), (files.get(norm(p)) ?? "") + text);
    },
    writeTextFile: async (p, content) => {
      files.set(norm(p), content);
    },
    makeDirectory: async () => {},
  };
}

function makeReportDeps(files: Map<string, string>, io: CliIo): ReportCommandDeps {
  return {
    fs: {
      readTextFileIfExists: async (p) => files.get(norm(p)),
      listFiles: async (dir) =>
        [...files.keys()]
          .filter((key) => norm(path.dirname(key)) === norm(dir))
          .map((key) => path.basename(key))
          .sort(),
    },
    contextFs: makeContextFs(files),
    adapterCapabilities: () => [],
    projectRoot: ROOT,
    nowIso: () => "2026-08-20T12:00:00.000Z",
    io,
  };
}

// ---------------------------------------------------------------------------
// token-usage-summary
// ---------------------------------------------------------------------------

test("token-usage-summary: griežtas parseris, grupavimas ir rikiavimas", () => {
  const raw = [
    JSON.stringify({ phase: "dispatch", model: "sonnet", input_tokens: 10, output_tokens: 5, total_cost_usd: 0.5 }),
    JSON.stringify({ phase: "dispatch", model: "sonnet", input_tokens: 3, cache_read_input_tokens: 7 }),
    JSON.stringify({ phase: "preflight", model: "none" }),
  ].join("\n");
  const lines = parseTokenUsageSummaryLines(raw);
  const summary = summarizeTokenUsage(lines);
  assert.deepEqual(summary, [
    {
      phase: "dispatch",
      model: "sonnet",
      records: 2,
      input_tokens: 13,
      output_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0.5,
    },
    {
      phase: "preflight",
      model: "none",
      records: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0,
    },
  ]);
  assert.deepEqual(summarizeTokenUsageByModel(lines), [
    { model: "sonnet", records: 2 },
    { model: "none", records: 1 },
  ]);
  assert.throws(() => parseTokenUsageSummaryLines("ne-json"), SyntaxError);
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function seedReportWorld(): Map<string, string> {
  const files = new Map<string, string>();
  files.set(abs("AG/tasks/queue/0001.md"), "task");
  files.set(abs("AG/tasks/queue/0002.md"), "task");
  files.set(abs("AG/tasks/done/0000.md"), "task");
  files.set(abs("vq/state/task-ledger.json"), JSON.stringify({ a: { state: "done" }, b: { state: "done" } }));
  files.set(
    abs("vq/logs/token-usage.jsonl"),
    `${JSON.stringify({ phase: "dispatch", task_id: "0001", model: "sonnet", input_tokens: 10 })}\n`,
  );
  files.set(
    abs("vq/logs/task-events.jsonl"),
    `${JSON.stringify({ ts: "2026-08-20T10:00:00.000Z", task_id: "0001", to_state: "done", reason: "ok" })}\n`,
  );
  return files;
}

test("reportCommand: renderis su bucket'ais, ledger state, usage ir outcomes", async () => {
  const { io, out } = captureIo();
  const exit = await reportCommand(makeReportDeps(seedReportWorld(), io), []);
  assert.equal(exit, 0);
  const text = out.join("\n");
  assert.ok(text.startsWith("AG local telemetry report\nGenerated: 2026-08-20T12:00:00.000Z"));
  assert.ok(text.includes("  queue: 2"));
  assert.ok(text.includes("  done: 1"));
  assert.ok(text.includes("  duplicate: 0"));
  assert.ok(text.includes("Task counts by ledger state:\n  done: 2"));
  assert.ok(text.includes("Adapter usage:\n  sonnet: 1"));
  assert.ok(text.includes("Adapter capabilities:\n  none"));
  assert.ok(
    text.includes(
      "  dispatch/sonnet: records=1, input=10, output=0, cache_read=0, cache_create=0, cost_usd=0",
    ),
  );
  assert.ok(text.includes("  2026-08-20T10:00:00.000Z 0001 -> done (ok)"));
  assert.ok(text.includes("Context size (latest task):\n  none"));
  assert.ok(text.includes("Context compression canary arrests:\n  none"));
});

test("reportCommand --json: struktūra su taskCounts ir tuščiu contextSize", async () => {
  const { io, out } = captureIo();
  const exit = await reportCommand(makeReportDeps(seedReportWorld(), io), ["--json"]);
  assert.equal(exit, 0);
  const report = JSON.parse(out.join("\n")) as LocalTelemetryReport;
  assert.equal(report.localOnly, true);
  assert.equal(report.taskCounts.buckets["queue"], 2);
  assert.deepEqual(report.contextSize, {});
  assert.deepEqual(report.compressionArrests, { arrests: [], unreadable: false });
});

test("buildLocalTelemetryReport: be task-events krenta į state-history fallback", async () => {
  const files = seedReportWorld();
  files.delete(abs("vq/logs/task-events.jsonl"));
  files.set(
    abs("vq/state/state-history.json"),
    JSON.stringify([{ timestamp: "2026-08-19T09:00:00.000Z", task_id: "0009", result: "done", reason: "istorija" }]),
  );
  const report = await buildLocalTelemetryReport(makeReportDeps(files, captureIo().io));
  assert.deepEqual(report.recentOutcomes, [
    { ts: "2026-08-19T09:00:00.000Z", task_id: "0009", outcome: "done", reason: "istorija" },
  ]);
});

// ---------------------------------------------------------------------------
// project-status
// ---------------------------------------------------------------------------

function makeStatusDeps(files: Map<string, string>, io: CliIo): ProjectStatusCommandDeps {
  const boom = (): never => {
    throw new Error("unexpected release-proof port call");
  };
  const releaseProof: ReleaseProofPorts = {
    gitHead: async () => boom(),
    countNumberedTasks: async () => boom(),
    writeSummary: async () => boom(),
    writeMarkdown: async () => boom(),
    readSummary: async () => undefined,
  };
  return {
    fs: {
      readTextFileIfExists: async (p) => files.get(norm(p)),
      listFiles: async (dir) =>
        [...files.keys()]
          .filter((key) => norm(path.dirname(key)) === norm(dir))
          .map((key) => path.basename(key))
          .sort(),
      listSubdirectories: async (dir) => {
        const prefix = `${norm(dir)}/`;
        const names = new Set<string>();
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (rest.includes("/")) names.add(rest.split("/")[0]!);
        }
        return [...names];
      },
      writeTextFile: async (p, text) => {
        files.set(norm(p), text);
      },
    },
    releaseProof,
    gitHead: async () => "abc123",
    projectRoot: ROOT,
    io,
  };
}

test("projectStatusCommand: rašo status.md + next-tasks.md ir spausdina etalono eilutes", async () => {
  const files = new Map<string, string>();
  files.set(abs("AG/tasks/queue/0007.md"), "task");
  files.set(abs("AG/tasks/human-review/0003.md"), "task");
  files.set(abs("AG/spec/changes/001-x/spec.json"), JSON.stringify({ id: "spec-001", status: "active" }));
  files.set(abs("vq/config/model-policy.json"), "{}");
  files.set(abs("vq/state/quality-gates-status.json"), JSON.stringify({ status: "green" }));
  files.set(
    abs("vq/state/architecture/progress.json"),
    JSON.stringify({ graph_hash: "h", nodes: { A: { status: "done" }, B: { status: "queued" } } }),
  );

  const { io, out } = captureIo();
  const exit = await projectStatusCommand(makeStatusDeps(files, io), []);
  assert.equal(exit, 0);
  assert.deepEqual(out, [
    "project-status: vq/project/status.md",
    "next-tasks: vq/project/next-tasks.md",
    "active_spec: spec-001",
  ]);

  const status = files.get(abs("vq/project/status.md"));
  assert.ok(status);
  assert.ok(status.startsWith("# VERQESTRA project status"));
  assert.ok(status.includes("- queue: 1"));
  assert.ok(status.includes("- human-review: 1"));
  assert.ok(status.includes("## Active Spec\n- spec-001"));
  assert.ok(status.includes("- model-policy.json: present"));
  assert.ok(status.includes("- tool-budget.json: missing"));
  assert.ok(status.includes("- quality-gates-status.json: green"));
  assert.ok(status.includes("- spec-drift-result.json: missing"));
  assert.ok(status.includes("- done: 1"));
  assert.ok(status.includes("- nodes_total: 2"));
  assert.ok(status.includes("- status: missing (final-audit-summary.json is missing)"));

  const nextTasks = files.get(abs("vq/project/next-tasks.md"));
  assert.ok(nextTasks);
  assert.ok(nextTasks.includes("- 0007.md"));
  assert.ok(nextTasks.includes("## Other Pending Work\n- human-review: 0003.md"));
});

test("projectStatusCommand: tuščias pasaulis — none reikšmės ir not initialized", async () => {
  const files = new Map<string, string>();
  const { io, out } = captureIo();
  const exit = await projectStatusCommand(makeStatusDeps(files, io), []);
  assert.equal(exit, 0);
  assert.equal(out[2], "active_spec: none");
  const status = files.get(abs("vq/project/status.md"));
  assert.ok(status);
  assert.ok(status.includes("## Architecture Progress\n- not initialized"));
  const nextTasks = files.get(abs("vq/project/next-tasks.md"));
  assert.ok(nextTasks);
  assert.ok(nextTasks.includes("- No queued tasks."));
  assert.ok(nextTasks.includes("## Other Pending Work\n- none"));
});
