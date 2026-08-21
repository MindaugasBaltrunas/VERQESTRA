// VQ-501 (5/5-b) testai — valdymo komandų handleriai per fake portus: policy show/propose/
// status (registro riba, schemos validacija kūrimo metu, tolerantiškas status), agent
// registro+personos pora (numatytojo vaidmens apsauga, adapterio/modelio validacija) ir
// status renderis (sugadinti būsenos failai nenutraukia ataskaitos).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { PolicyProposal } from "../application/policy-governance/policy-proposals-log.js";
import type { TokenAnalyticsSnapshot } from "../application/learning/token-analytics-snapshot.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import { policyCommand, type PolicyCommandPorts } from "../interfaces/cli/admin/policy.js";
import { agentCommand, type AgentCommandPorts } from "../interfaces/cli/admin/agent.js";
import { statusCommand, type StatusPorts } from "../interfaces/cli/admin/status.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));
const NOW = new Date("2026-08-21T10:00:00.000Z");

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

function policyPorts(files: Record<string, string> = {}): {
  ports: PolicyCommandPorts;
  appended: string[];
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(files));
  const appended: string[] = [];
  const read = async (p: string): Promise<string | undefined> => store.get(rel(p));
  return {
    store,
    appended,
    ports: {
      configFs: { readTextFileIfExists: read },
      proposalsFs: {
        readTextFileIfExists: read,
        appendTextFile: async (p, text) => {
          appended.push(text);
          store.set(rel(p), `${store.get(rel(p)) ?? ""}${text}`);
        },
        makeDirectory: async () => {},
      },
    },
  };
}

test("policyCommand: show spausdina tris sekcijas, --json — vieną objektą", async () => {
  const { ports } = policyPorts();
  const text = captureIo();
  assert.equal(await policyCommand({ ports, runtimeRoot: RUNTIME_ROOT, io: text.io }, ["show"]), 0);
  assert.equal(text.out[0], "=== architecture-style ===");
  assert.ok(text.out.includes("=== coding-principles ==="));
  assert.ok(text.out.includes("=== enforcement ==="));

  const json = captureIo();
  assert.equal(await policyCommand({ ports, runtimeRoot: RUNTIME_ROOT, io: json.io }, ["show", "--json"]), 0);
  const parsed = JSON.parse(json.out.join("\n")) as Record<string, { version: string }>;
  // Trūkstami konfigai duoda kodinius default'us, ne klaidą (bootstrap projektas jų neturi).
  assert.equal(parsed["architecture_style"]?.version, "1.0");
  assert.equal(parsed["coding_principles"]?.version, "1.0");
  assert.equal(parsed["enforcement"]?.version, "1.0");
});

test("policyCommand: propose įrašo validuotą pasiūlymą su old_value ir routing'u", async () => {
  const world = policyPorts({
    "vq/architecture/coding-principles.json": JSON.stringify({ single_responsibility: "warn" }),
  });
  const { io, out } = captureIo();
  const exit = await policyCommand(
    { ports: world.ports, runtimeRoot: RUNTIME_ROOT, now: () => NOW, io },
    [
      "propose",
      "vq/architecture/coding-principles.json",
      "single_responsibility",
      '"block"',
      "--reason",
      "SRP gate",
      "--routing",
      "human-review",
    ],
  );

  assert.equal(exit, 0);
  assert.equal(out[0], "Proposal saved: single_responsibility in vq/architecture/coding-principles.json → human-review");
  assert.equal(world.appended.length, 1);
  const proposal = JSON.parse(world.appended[0] ?? "{}") as PolicyProposal;
  assert.equal(proposal.old_value, "warn");
  assert.equal(proposal.requested_value, "block");
  assert.equal(proposal.reason, "SRP gate");
  assert.equal(proposal.routing, "human-review");
  assert.equal(proposal.timestamp, NOW.toISOString());
});

test("policyCommand: nepalaikomas failas, trūkstami argumentai ir blogas routing — 1, nieko neįrašo", async () => {
  const world = policyPorts();
  const deps = { ports: world.ports, runtimeRoot: RUNTIME_ROOT, now: () => NOW };

  const unsupported = captureIo();
  assert.equal(
    await policyCommand({ ...deps, io: unsupported.io }, ["propose", "vq/config/other.json", "x", "1"]),
    1,
  );
  assert.match(unsupported.err[0] ?? "", /^Unsupported policy file: vq\/config\/other\.json/);

  const usage = captureIo();
  assert.equal(await policyCommand({ ...deps, io: usage.io }, ["propose"]), 1);
  assert.match(usage.err[0] ?? "", /^Usage: policy propose /);

  const routing = captureIo();
  assert.equal(
    await policyCommand({ ...deps, io: routing.io }, [
      "propose",
      "vq/architecture/coding-principles.json",
      "dry",
      '"block"',
      "--routing",
      "email",
    ]),
    1,
  );
  assert.equal(routing.err[0], "Invalid routing 'email'; use queue, human-review");

  assert.equal(world.appended.length, 0, "nė vienas atmestas pasiūlymas nepateko į žurnalą");
});

test("policyCommand: schemos neatitinkanti reikšmė atmetama KŪRIMO metu", async () => {
  const world = policyPorts();
  const { io, err } = captureIo();
  const exit = await policyCommand({ ports: world.ports, runtimeRoot: RUNTIME_ROOT, io }, [
    "propose",
    "vq/architecture/coding-principles.json",
    "dry",
    '"banana"',
  ]);
  assert.equal(exit, 1);
  assert.match(err[0] ?? "", /^Invalid value for dry in vq\/architecture\/coding-principles\.json:/);
  assert.equal(world.appended.length, 0);
});

test("policyCommand: status be failo, su eilutėmis ir su korumpuota eilute", async () => {
  const empty = policyPorts();
  const none = captureIo();
  assert.equal(await policyCommand({ ports: empty.ports, runtimeRoot: RUNTIME_ROOT, io: none.io }, ["status"]), 0);
  assert.equal(none.out[0], "No proposals found.");

  const noneJson = captureIo();
  assert.equal(
    await policyCommand({ ports: empty.ports, runtimeRoot: RUNTIME_ROOT, io: noneJson.io }, ["status", "--json"]),
    0,
  );
  assert.equal(noneJson.out[0], "[]");

  const good = JSON.stringify({ setting_id: "dry" });
  const world = policyPorts({ "vq/state/policy/proposals.jsonl": `${good}\nnot-json\n` });
  const raw = captureIo();
  assert.equal(await policyCommand({ ports: world.ports, runtimeRoot: RUNTIME_ROOT, io: raw.io }, ["status"]), 0);
  assert.deepEqual(raw.out, [good, "not-json"]);

  const jsonMode = captureIo();
  assert.equal(
    await policyCommand({ ports: world.ports, runtimeRoot: RUNTIME_ROOT, io: jsonMode.io }, ["status", "--json"]),
    0,
  );
  // Korumpuota eilutė praleidžiama, o ne nutraukia peržiūrą.
  assert.deepEqual(JSON.parse(jsonMode.out.join("\n")), [{ setting_id: "dry" }]);
});

test("policyCommand: nežinoma subkomanda — 1 su naudojimo eilute", async () => {
  const { ports } = policyPorts();
  const { io, err } = captureIo();
  assert.equal(await policyCommand({ ports, runtimeRoot: RUNTIME_ROOT, io }, ["frobnicate"]), 1);
  assert.equal(err[0], "Usage: policy [show|propose|status] [--json]");
});

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

const BASE_POLICY = {
  version: "1",
  default_role: "coder",
  roles: {
    coder: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: true },
    reviewer: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: false, enabled: false },
  },
};

function agentPorts(input: { policy?: unknown; personas?: string[] } = {}): {
  ports: AgentCommandPorts;
  written: Map<string, string>;
  registry: unknown[];
  removed: string[];
} {
  const personas = new Set(input.personas ?? []);
  const written = new Map<string, string>();
  const registry: unknown[] = [];
  const removed: string[] = [];
  const policyRaw = JSON.stringify(input.policy ?? BASE_POLICY);
  return {
    written,
    registry,
    removed,
    ports: {
      policyFs: {
        readTextFileIfExists: async (p) => (rel(p) === "vq/config/agents.json" ? policyRaw : undefined),
      },
      listPersonaFiles: async () => [...personas],
      readTextFile: async (p) => written.get(rel(p)) ?? `---\nname: from-file\n---\n`,
      writeTextFile: async (p, content) => void written.set(rel(p), content),
      writeJsonFile: async (_p, value) => void registry.push(value),
      removeFile: async (p) => void removed.push(rel(p)),
      exists: async (p) => personas.has(path.basename(p)),
    },
  };
}

test("agentCommand: list rodo registruotus ir tik-personos agentus su statusais", async () => {
  const { ports } = agentPorts({ personas: ["coder.md", "tester.md"] });
  const text = captureIo();
  assert.equal(await agentCommand({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: text.io }, ["list"]), 0);
  assert.equal(text.out[0], "Default agent: coder");
  assert.ok(text.out.some((line) => line.startsWith("coder\tenabled\tyes")));
  assert.ok(text.out.some((line) => line.startsWith("reviewer\tdisabled\tmissing")));
  assert.ok(text.out.some((line) => line.startsWith("tester\tunregistered\tyes")));

  const json = captureIo();
  assert.equal(
    await agentCommand({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: json.io }, ["list", "--json"]),
    0,
  );
  const listed = JSON.parse(json.out.join("\n")) as {
    default_role: string;
    agents: Array<{ name: string; registered: boolean; persona: boolean }>;
  };
  assert.equal(listed.default_role, "coder");
  assert.deepEqual(
    listed.agents.map((row) => row.name),
    ["coder", "reviewer", "tester"],
  );
  assert.equal(listed.agents.find((row) => row.name === "tester")?.registered, false);
});

test("agentCommand: add rašo personą ir registrą; dublikatas be --force ir blogas modelis — 2", async () => {
  const world = agentPorts({});
  const { io, out } = captureIo();
  const exit = await agentCommand({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, [
    "add",
    "auditor",
    "--model",
    "opus",
    "--read-only",
  ]);

  assert.equal(exit, 0);
  assert.equal(out[0], "Added agent 'auditor'");
  assert.ok(out.includes("Registry: vq/config/agents.json"));
  const persona = world.written.get(".claude/agents/auditor.md") ?? "";
  assert.match(persona, /^---\nname: auditor\n/);
  const saved = world.registry[0] as { roles: Record<string, { default_model_hint: string; can_write_code: boolean }> };
  assert.equal(saved.roles["auditor"]?.default_model_hint, "opus");
  assert.equal(saved.roles["auditor"]?.can_write_code, false);

  const duplicate = captureIo();
  assert.equal(
    await agentCommand({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: duplicate.io }, [
      "add",
      "coder",
    ]),
    2,
  );
  assert.match(duplicate.err[0] ?? "", /already exists; use --force/);

  const badModel = captureIo();
  assert.equal(
    await agentCommand({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: badModel.io }, [
      "add",
      "auditor2",
      "--model",
      "gpt",
    ]),
    2,
  );
  assert.equal(badModel.err[0], "Invalid model 'gpt'; use haiku, sonnet, opus");
});

test("agentCommand: numatytojo vaidmens negalima išjungti, o enable be personos atmetamas", async () => {
  const world = agentPorts({ personas: ["coder.md"] });
  const deps = { ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT };

  const disableDefault = captureIo();
  assert.equal(await agentCommand({ ...deps, io: disableDefault.io }, ["disable", "coder"]), 2);
  assert.equal(disableDefault.err[0], "Cannot disable default agent 'coder'");

  const enableMissing = captureIo();
  assert.equal(await agentCommand({ ...deps, io: enableMissing.io }, ["enable", "reviewer"]), 2);
  assert.match(enableMissing.err[0] ?? "", /\.claude\/agents\/reviewer\.md is missing/);

  const unregistered = captureIo();
  assert.equal(await agentCommand({ ...deps, io: unregistered.io }, ["enable", "ghost"]), 2);
  assert.equal(unregistered.err[0], "Agent 'ghost' is not registered");
  assert.equal(world.registry.length, 0, "atmestas veiksmas registro nekeičia");
});

test("agentCommand: remove šalina personą, --keep-file ją palieka, numatytasis apsaugotas", async () => {
  const world = agentPorts({ personas: ["reviewer.md"] });
  const deps = { ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT };

  const removed = captureIo();
  assert.equal(await agentCommand({ ...deps, io: removed.io }, ["remove", "reviewer"]), 0);
  assert.equal(removed.out[0], "Removed agent 'reviewer'");
  assert.deepEqual(world.removed, [".claude/agents/reviewer.md"]);

  const kept = captureIo();
  assert.equal(await agentCommand({ ...deps, io: kept.io }, ["remove", "reviewer", "--keep-file"]), 0);
  assert.equal(kept.out[0], "Removed agent 'reviewer' from registry (persona kept)");
  assert.equal(world.removed.length, 1, "--keep-file nieko netrina");

  const defaultRole = captureIo();
  assert.equal(await agentCommand({ ...deps, io: defaultRole.io }, ["remove", "coder"]), 2);
  assert.equal(defaultRole.err[0], "Cannot remove default agent 'coder'");

  const unknown = captureIo();
  assert.equal(await agentCommand({ ...deps, io: unknown.io }, ["frobnicate"]), 2);
  assert.match(unknown.err[0] ?? "", /^Usage: verqestra agent /);
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

const ANALYTICS: TokenAnalyticsSnapshot = {
  generatedAt: NOW.toISOString(),
  totals: { records: 10, totalTokens: 1000, uniqueTasks: 4 },
  tokensByPhase: [],
  tokensByModel: [],
  tokensByDay: [],
  fastPathHitRate: { preflight: 0, diagnose: 0 },
  cacheHitRate: 0.5,
  repairShare: 0.25,
  groupMedians: [],
};

function statusPorts(files: Record<string, string> = {}, overrides: Partial<StatusPorts> = {}): StatusPorts {
  return {
    ensureDirs: async () => {},
    countMarkdownFiles: async (dir) => (rel(dir) === "AG/tasks/queue" ? 2 : 0),
    listMarkdownFiles: async (dir) => (rel(dir) === "AG/tasks/queue" ? ["0001.md", "0002.md"] : []),
    readTextFileIfExists: async (p) => files[rel(p)],
    readStopEvidence: async () => ({ origin: "attempt", corrupted: false }),
    readTokenAnalytics: async () => null,
    gitStatus: async () => "",
    ...overrides,
  };
}

test("statusCommand: pilna ataskaita — bucket'ai, einamasis task'as, analitika, stop, resume, sprendimas", async () => {
  const files: Record<string, string> = {
    "vq/state/current-task-id": "0042",
    "vq/state/claude-last-exit-code": "0",
    "vq/state/stable-ref": "c".repeat(40),
    "vq/state/claude-resume.json": JSON.stringify({ actor: "claude", status: "finished", phase: "dispatch" }),
    "vq/supervisor/decision.json": JSON.stringify({ verdict: "approved", task_id: "0042", selected_model: "sonnet" }),
  };
  const ports = statusPorts(files, {
    readTokenAnalytics: async () => ANALYTICS,
    readStopEvidence: async (taskId) => ({
      origin: taskId === "0042" ? "attempt" : "legacy",
      status: "done",
      reason: "verified",
      corrupted: false,
    }),
    gitStatus: async () => " M src/a.ts",
  });

  const { io, out } = captureIo();
  const exit = await statusCommand({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io });

  assert.equal(exit, 0);
  assert.equal(out[0], "AG status");
  assert.ok(out.some((line) => line.startsWith("  queue:") && line.endsWith("2")));
  assert.ok(out.includes("  - 0001.md"));
  assert.ok(out.includes("current_task_id: 0042"));
  assert.ok(out.includes(`stable_ref: ${"c".repeat(40)}`));
  assert.ok(out.includes("  tokens_per_task:  250"));
  assert.ok(out.includes("  repair_share:     25.0%"));
  assert.ok(out.includes("claude_stop_status: done"));
  assert.ok(out.includes("claude_stop_reason: verified"));
  assert.ok(out.includes("claude_stop_source: attempt"));
  assert.ok(out.includes("resume_points:"));
  assert.ok(out.some((line) => line.startsWith("  claude: finished dispatch task=")));
  assert.ok(out.includes("latest_decision:"));
  assert.ok(out.at(-1)?.includes("M src/a.ts"));
});

test("statusCommand: sugadinti būsenos JSON failai nenutraukia ataskaitos", async () => {
  const ports = statusPorts({
    "vq/state/claude-resume.json": "{ broken",
    "vq/supervisor/decision.json": "not-json",
  });
  const { io, out } = captureIo();
  assert.equal(await statusCommand({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }), 0);
  assert.ok(!out.includes("resume_points:"));
  assert.ok(!out.includes("latest_decision:"));
  assert.equal(out.at(-1), "git_status:");
});

test("statusCommand: be analitikos ir be stop įrodymo sekcijos praleidžiamos; corrupted pažymimas", async () => {
  const quiet = captureIo();
  assert.equal(
    await statusCommand({ ports: statusPorts(), projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: quiet.io }),
    0,
  );
  assert.ok(!quiet.out.includes("token_analytics:"));
  assert.ok(!quiet.out.some((line) => line.startsWith("claude_stop_status:")));

  const corrupted = captureIo();
  const ports = statusPorts({}, { readStopEvidence: async () => ({ origin: "legacy", corrupted: true }) });
  assert.equal(
    await statusCommand({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: corrupted.io }),
    0,
  );
  assert.ok(corrupted.out.includes("claude_stop_status: <corrupted>"));
  assert.ok(corrupted.out.includes("claude_stop_source: legacy"));
});
