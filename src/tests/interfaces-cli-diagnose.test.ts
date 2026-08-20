// VQ-501 (2/5-c) testai — claude-diagnose adapteris per fake ClaudeDiagnosePorts + NAUJA
// session-write-owners taisyklė ir diagnozės prompt/evidence pagalbininkai.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  filterStagePathsByOwnership,
  sessionWriteOwnersPath,
  type SessionWriteOwners,
} from "../application/task-execution/session-write-owners.js";
import type { QualityGatesStatus } from "../application/quality-gates/quality-gates-status.js";
import { USAGE_ERROR_EXIT_CODE } from "../shared/exit-codes.js";
import { claudeDiagnose } from "../interfaces/cli/dispatch/claude-diagnose/index.js";
import { stripStreamJsonTranscriptLines, tailLines } from "../interfaces/cli/dispatch/claude-diagnose/diagnose-evidence.js";
import { buildDiagnosisPrompt, renderStopBlock } from "../interfaces/cli/dispatch/claude-diagnose/diagnose-prompt.js";
import type {
  ClaudeDiagnosePorts,
  DiagnosisDecision,
  StopEvidenceView,
} from "../interfaces/cli/dispatch/claude-diagnose/diagnose-ports.js";

const ROOT = path.resolve("/repo");
const TASK_FILE = path.join(ROOT, "AG", "tasks", "queue", "0042-demo.md");

const TASK_TEXT = [
  "# Task",
  "",
  "## Tikslas",
  "Padaryti X.",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/a.ts`",
  "",
  "## Patikra",
  "- `pnpm test`",
  "",
].join("\n");

test("session-write-owners: filtras meta tik ĮRODYTAI svetimus kelius; sidecar kelias", () => {
  const owners: SessionWriteOwners = {
    "src/svetimas.ts": { sessions: ["kita-sesija"], tasks: ["0099"] },
    "src/savas.ts": { sessions: ["mano-sesija"], tasks: ["0042"] },
    "src/bendras.ts": { sessions: ["kita-sesija"], tasks: ["0042"] },
  };
  const identity = { session: "mano-sesija", taskId: "0042" };
  const result = filterStagePathsByOwnership(
    ["src/svetimas.ts", "src/savas.ts", "src/bendras.ts", "src/be-iraso.ts"],
    owners,
    identity,
  );
  assert.deepEqual(result.foreign, ["src/svetimas.ts"]);
  assert.deepEqual(result.paths, ["src/savas.ts", "src/bendras.ts", "src/be-iraso.ts"], "to paties task'o kelias lieka");

  // Be savo tapatybės NIEKAS nemetama (interaktyvi sesija).
  const anonymous = filterStagePathsByOwnership(["src/svetimas.ts"], owners, { session: "", taskId: "" });
  assert.deepEqual(anonymous.foreign, []);
  assert.equal(
    sessionWriteOwnersPath(path.join(ROOT, "vq", "state", "session-writes.json")),
    path.join(ROOT, "vq", "state", "session-write-owners.json"),
  );
});

test("evidence pagalbininkai: stream-json triukšmo filtras (0024) ir tail", () => {
  const mixed = ['{"type":"user","text":"TypeError inside quote"}', "SyntaxError: Unexpected end of JSON input", "[event]"].join("\n");
  assert.equal(stripStreamJsonTranscriptLines(mixed), "SyntaxError: Unexpected end of JSON input");
  assert.equal(tailLines("a\nb\nc", 2), "b\nc");
  assert.equal(tailLines("", 5), "");
});

test("renderStopBlock: foreign/corrupted/normalios šakos 1:1", () => {
  assert.match(
    renderStopBlock({ foreign: true, corrupted: false, raw: "RAW", stopTaskId: "kitas", taskId: "0042" }),
    /ignoruota — priklauso kitam task_id "kitas"/,
  );
  assert.match(
    renderStopBlock({ foreign: false, corrupted: true, raw: "RAW", stopTaskId: undefined, taskId: "0042" }),
    /neparsinamas stop įrodymas/,
  );
  assert.equal(renderStopBlock({ foreign: false, corrupted: false, raw: "RAW", stopTaskId: "0042", taskId: "0042" }), "RAW");
});

test("buildDiagnosisPrompt: sekcijos, digest'ai ir reduced skalė", () => {
  const base = {
    taskId: "0042-demo",
    taskText: TASK_TEXT,
    claudeExitRaw: "0",
    stopOrigin: "attempt",
    stopBlock: '{"status":"done"}',
    gitStatusText: "",
    gitHead: "abc123",
    commitsSinceStart: "abc123 darbo commit",
    checksTail: "error TS2345: neteisingas tipas",
    claudeLogOrigin: "attempt",
    claudeLogText: "runner output",
    retryCountsRaw: JSON.stringify({ "task:0042-demo": 1 }),
    previousErrorSignature: "",
    modelSelectionRules: "- MODELIO TAISYKLĖS",
    reduceContext: false,
  };
  const prompt = buildDiagnosisPrompt(base);
  assert.ok(prompt.includes("## Task ID\n0042-demo"));
  assert.ok(prompt.includes("(source: attempt)"));
  assert.ok(prompt.includes("- MODELIO TAISYKLĖS"));
  assert.ok(prompt.includes("error TS2345"));
  assert.ok(prompt.includes("(nėra — pirmas bandymas arba anksčiau nebuvo repair)"));

  const reduced = buildDiagnosisPrompt({ ...base, taskText: "x".repeat(3000), reduceContext: true });
  assert.ok(!reduced.includes("x".repeat(900)), "reduced skalė kerpa task ištrauką iki 800");
});

type HarnessInput = {
  gatesPassed?: boolean | undefined;
  exitRaw?: string;
  stop?: Partial<StopEvidenceView>;
  gitStatus?: string;
  withWindowCommit?: boolean;
  checksLog?: string;
  sessionWrites?: { present: boolean; writes: string[]; owners: SessionWriteOwners };
  errorSignatures?: Record<string, string>;
  envNonce?: string;
};

type Harness = {
  ports: ClaudeDiagnosePorts;
  decisions: DiagnosisDecision[];
  attemptDecisions: DiagnosisDecision[];
  repairWrites: string[];
  globalRepairs: string[];
  usageLogs: Array<[string, string, string | undefined]>;
  agLines: string[];
  errs: string[];
};

function makeHarness(input: HarnessInput = {}): Harness {
  const decisions: DiagnosisDecision[] = [];
  const attemptDecisions: DiagnosisDecision[] = [];
  const repairWrites: string[] = [];
  const globalRepairs: string[] = [];
  const usageLogs: Array<[string, string, string | undefined]> = [];
  const agLines: string[] = [];
  const errs: string[] = [];

  const stop: StopEvidenceView = {
    origin: "attempt",
    status: "done",
    taskId: "0042-demo",
    corrupted: false,
    raw: '{"status":"done"}',
    warnings: [],
    record: { dispatch_nonce: "nonce12345" },
    ...input.stop,
  };

  const ports: ClaudeDiagnosePorts = {
    projectRoot: ROOT,
    runtimeRoot: path.join(ROOT, "vq"),
    ensureDirs: async () => {},
    resolveExistingTaskFile: async () => TASK_FILE,
    readOptionalFile: async (absolutePath) => {
      if (absolutePath === TASK_FILE) return TASK_TEXT;
      if (absolutePath.endsWith("claude-last-exit-code")) return input.exitRaw ?? "0";
      if (absolutePath.endsWith("checks-last.log")) return input.checksLog ?? "";
      return "";
    },
    git: {
      status: async () => input.gitStatus ?? "",
      head: async () => "abc123",
      logSince: async () => (input.withWindowCommit ? "abc123 darbo commit" : ""),
      changedProductPathsSince: async () => [],
    },
    windowProductWorkSha: async () => (input.withWindowCommit ? "abc123" : undefined),
    readTaskStartStatus: async () => (input.withWindowCommit ? { task_id: "0042-demo", base_head: "base" } : {}),
    readStopEvidence: async () => stop,
    readClaudeSessionLog: async () => ({ origin: "attempt", text: "runner output" }),
    readGatesStatus: async () =>
      input.gatesPassed === undefined ? undefined : ({ passed: input.gatesPassed } as QualityGatesStatus),
    readRetryCounts: async () => ({}),
    readRetryCountsRaw: async () => "{}",
    readErrorSignatures: async () => input.errorSignatures ?? {},
    readLegacyErrorSignature: async () => "",
    readSessionWrites: async () => input.sessionWrites ?? { present: true, writes: [], owners: {} },
    readCurrentTaskId: async () => "0042-demo",
    envDispatchNonce: () => input.envNonce ?? "",
    authorizeLlmCall: async () => {
      throw new Error("LLM biudžeto vartai nepasiekiami — lokali diagnozė privalo nuspręsti pati");
    },
    resolveDiagnosisModel: async () => "model-haiku",
    modelSelectionRules: "- MODELIO TAISYKLĖS",
    runHeadless: async () => {
      throw new Error("LLM kelias nepasiekiamas dabartinėse dispozicijų taisyklėse");
    },
    parseDecision: () => ({}),
    isUsageLimitOutput: () => false,
    logTokenUsage: async (phase, model, stdout) => {
      usageLogs.push([phase, model, stdout]);
    },
    loadDiagnoseLimits: async () => ({ llmMaxTurns: 12 }),
    attempt: {
      writeDecision: async (decision) => {
        attemptDecisions.push(decision);
      },
      appendRepairPrompt: async () => {},
      appendDiagnosisInput: async () => {},
    },
    files: {
      writeDecision: async (json) => {
        decisions.push(JSON.parse(json) as DiagnosisDecision);
      },
      writeRepairPrompt: async (scoped) => {
        repairWrites.push(scoped);
      },
      writeGlobalRepair: async (scoped) => {
        globalRepairs.push(scoped);
      },
      writeDiagnosisInput: async () => {},
      writeSupervisorLog: async () => {},
    },
    recordResumeCheckpoint: async () => {},
    agLog: async (line) => {
      agLines.push(line);
    },
    stderr: (line) => {
      errs.push(line);
    },
  };
  return { ports, decisions, attemptDecisions, repairWrites, globalRepairs, usageLogs, agLines, errs };
}

test("claudeDiagnose: usage → USAGE_ERROR_EXIT_CODE", async () => {
  const h = makeHarness();
  assert.equal(await claudeDiagnose([], h.ports), USAGE_ERROR_EXIT_CODE);
  assert.match(h.errs[0] ?? "", /Usage: ag claude-diagnose/);
});

test("claudeDiagnose: deterministinis done greitkelis — attempt+files paritetas, tušti repair artefaktai", async () => {
  const h = makeHarness({ gatesPassed: true, withWindowCommit: true });
  assert.equal(await claudeDiagnose(["t"], h.ports), 0);
  const decision = h.decisions[0]!;
  assert.equal(decision.verdict, "done");
  assert.match(decision.reason ?? "", /deterministic-done: gates passed, stop done, new commit present/);
  assert.deepEqual(h.attemptDecisions[0], decision);
  assert.deepEqual(h.repairWrites, [""]);
  assert.deepEqual(h.globalRepairs, [""]);
  assert.deepEqual(h.usageLogs[0], ["diagnose-fastpath", "none", undefined]);
});

test("claudeDiagnose: lokalus repair — checks nepraėjo, repair prompt'as su originalo scope (1045)", async () => {
  const h = makeHarness({
    gatesPassed: false,
    checksLog: "error TS2345: netinkamas tipas src/a.ts\n",
  });
  assert.equal(await claudeDiagnose(["t"], h.ports), 0);
  const decision = h.decisions[0]!;
  assert.equal(decision.verdict, "repair");
  assert.equal(decision.target_agent, "debugger");
  assert.match(decision.error_signature ?? "", /clear local issue: error TS2345/);
  const repair = h.repairWrites[0]!;
  assert.ok(repair.includes("# Repair Task"));
  assert.ok(repair.includes("`src/a.ts`"), "carryTaskScopeIntoRepairPrompt perkėlė ## Failai scope");
  assert.ok(repair.includes("`pnpm test`"), "originalo ## Patikra komandos perkeltos");
  assert.deepEqual(h.usageLogs[0], ["diagnose-local", "none", undefined]);
});

test("claudeDiagnose: pasikartojanti klaida eskaluojama į human_review (F9)", async () => {
  const first = makeHarness({ gatesPassed: false, checksLog: "error TS2345: netinkamas tipas src/a.ts\n" });
  await claudeDiagnose(["t"], first.ports);
  const signature = first.decisions[0]!.retry_key!;

  const repeated = makeHarness({
    gatesPassed: false,
    checksLog: "error TS2345: netinkamas tipas src/a.ts\n",
    errorSignatures: { "0042-demo": signature },
  });
  assert.equal(await claudeDiagnose(["t"], repeated.ports), 0);
  assert.equal(repeated.decisions[0]!.verdict, "human_review");
  assert.equal(repeated.decisions[0]!.risk_level, "high");
});

test("claudeDiagnose: out-of-scope pending rašymas → human_review; įrodytai svetimas kelias išfiltruojamas → done", async () => {
  const outside = makeHarness({
    gatesPassed: true,
    gitStatus: " M src/kitas.ts\n",
    sessionWrites: { present: true, writes: ["src/kitas.ts"], owners: {} },
  });
  assert.equal(await claudeDiagnose(["t"], outside.ports), 0);
  assert.equal(outside.decisions[0]!.verdict, "human_review");
  assert.match(outside.decisions[0]!.reason ?? "", /changed files outside allowed paths: src\/kitas\.ts/);

  const foreign = makeHarness({
    gatesPassed: true,
    gitStatus: " M src/kitas.ts\n",
    sessionWrites: {
      present: true,
      writes: ["src/kitas.ts"],
      owners: { "src/kitas.ts": { sessions: ["kita-sesija"], tasks: ["0099"] } },
    },
    envNonce: "nonce12345",
  });
  assert.equal(await claudeDiagnose(["t"], foreign.ports), 0);
  assert.ok(foreign.agLines.some((line) => line.includes("SESSION WRITES FOREIGN")));
  assert.equal(foreign.decisions[0]!.verdict, "done", "be pending rašymų checks-passed kelias uždaro lokaliai");
  assert.match(foreign.decisions[0]!.reason ?? "", /checks passed and changed files are inside allowed paths/);
});

test("claudeDiagnose: trūkstamas ledger'is — saugus fallback su WARNING, be klaidingo human_review", async () => {
  const h = makeHarness({
    gatesPassed: true,
    gitStatus: " M src/a.ts\n",
    sessionWrites: { present: false, writes: [], owners: {} },
  });
  assert.equal(await claudeDiagnose(["t"], h.ports), 0);
  assert.ok(h.agLines.some((line) => line.includes("session-writes.json missing")));
  assert.equal(h.decisions[0]!.verdict, "done");
});
