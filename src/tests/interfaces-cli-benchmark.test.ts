// VQ-501 (4/5-c) testai — benchmark klasterio CLI handleriai per fake portus: paketo tilto
// pasenimo/klaidų kelias (visos infrastruktūros baigtys → 5), ag-loop invocation šablono
// merge'as su paketo default'ais, benchmark-drive argumentų kontraktas ir telemetrijos
// envelope (429 → 75, vaiko kodas propaguojamas, envelope tik sėkmės kelyje) bei
// optimization-benchmark režimai virš VQ-305 application logikos.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { BenchmarkCaptureFsPort } from "../application/benchmark/optimization-config.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import {
  AG_LOOP_STEP_LIMIT,
  BENCHMARK_BUILD_COMMAND,
  BENCHMARK_INFRASTRUCTURE_EXIT_CODE,
  BENCHMARK_PACKAGE_ENTRY,
  agLoopInvocationTemplate,
  benchmarkCommand,
  type BenchmarkCommandDeps,
} from "../interfaces/cli/benchmark/benchmark-package.js";
import {
  benchmarkDriveCommand,
  parseBenchmarkDriveArgs,
  type BenchmarkDrivePorts,
  type BenchmarkDriveRunResult,
} from "../interfaces/cli/benchmark/benchmark-drive.js";
import { optimizationBenchmarkCommand } from "../interfaces/cli/benchmark/optimization-benchmark.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (value: string): string => value.replace(/\\/g, "/");
const abs = (rel: string): string => norm(path.join(ROOT, rel));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

// ---------------------------------------------------------------------------
// benchmark — tiltas į AG/benchmark paketą
// ---------------------------------------------------------------------------

const PACKAGE_ENTRY = norm(path.join(ROOT, BENCHMARK_PACKAGE_ENTRY));
const CLI_ENTRY = norm(path.join(ROOT, "dist", "cli.js"));

function bridgeDeps(overrides: {
  exists?: boolean;
  load?: () => Promise<unknown>;
  io: CliIo;
}): BenchmarkCommandDeps {
  return {
    packageLoader: {
      exists: async (p) => norm(p) === PACKAGE_ENTRY && (overrides.exists ?? true),
      load: overrides.load ?? (async () => ({})),
    },
    projectRoot: ROOT,
    nodeExecPath: "/usr/bin/node",
    cliEntry: CLI_ENTRY,
    io: overrides.io,
  };
}

test("benchmarkCommand: nesamas paketo build'as — infrastruktūros kodas ir statymo komanda", async () => {
  const { io, err } = captureIo();
  const exit = await benchmarkCommand(bridgeDeps({ exists: false, io }), ["run"]);
  assert.equal(exit, BENCHMARK_INFRASTRUCTURE_EXIT_CODE);
  assert.equal(err.length, 1);
  assert.ok(err[0]?.startsWith("benchmark: "));
  assert.ok(err[0]?.includes(BENCHMARK_BUILD_COMMAND));
});

test("benchmarkCommand: modulis be runBenchmarkCommand — pasenęs build'as", async () => {
  const { io, err } = captureIo();
  const exit = await benchmarkCommand(bridgeDeps({ load: async () => ({}), io }), []);
  assert.equal(exit, BENCHMARK_INFRASTRUCTURE_EXIT_CODE);
  assert.ok(err[0]?.includes("neeksportuoja runBenchmarkCommand"));
});

test("benchmarkCommand: yra runBenchmarkCommand, bet nėra createAgentInvocations — mokami režimai prarasti", async () => {
  const { io, err } = captureIo();
  const load = async (): Promise<unknown> => ({ runBenchmarkCommand: async () => 0 });
  const exit = await benchmarkCommand(bridgeDeps({ load, io }), []);
  assert.equal(exit, BENCHMARK_INFRASTRUCTURE_EXIT_CODE);
  assert.ok(err[0]?.includes("neeksportuoja createAgentInvocations"));
});

test("benchmarkCommand: sėkmė — argv persiunčiamas, ag-loop šablonas merge'inamas prie paketo default'ų", async () => {
  const { io, out } = captureIo();
  let seenArgv: readonly string[] = [];
  let seenConfig: Record<string, unknown> = {};
  const load = async (): Promise<unknown> => ({
    DEFAULT_AGENT_INVOCATION_CONFIG: { "agent-solo": { command: "solo" } },
    createAgentInvocations: (options?: unknown) => {
      seenConfig = (options as { config: Record<string, unknown> }).config;
      return { built: true };
    },
    runBenchmarkCommand: async (argv: readonly string[], packageIo: { out: (line: string) => void }) => {
      seenArgv = argv;
      packageIo.out("benchmark ok");
      return 3;
    },
  });

  const exit = await benchmarkCommand(bridgeDeps({ load, io }), ["run", "--allow-network"]);
  assert.equal(exit, 3);
  assert.deepEqual([...seenArgv], ["run", "--allow-network"]);
  assert.deepEqual(out, ["benchmark ok"]);
  // Paketo šablonas išlieka: plikas ag-loop įrašas tyliai atimtų agent-solo režimą.
  assert.ok(seenConfig["agent-solo"]);
  assert.deepEqual(seenConfig["ag-loop"], agLoopInvocationTemplate("/usr/bin/node", CLI_ENTRY));
});

test("agLoopInvocationTemplate: promptas per stdin, limitai argumentais, kredencialai tik vardais", () => {
  const template = agLoopInvocationTemplate("/usr/bin/node", CLI_ENTRY);
  assert.equal(template.command, "/usr/bin/node");
  assert.equal(template.args[0], CLI_ENTRY);
  assert.equal(template.args[1], "benchmark-drive");
  assert.ok(template.args.includes("{{workingDirectory}}"));
  assert.ok(template.args.includes("{{timeoutMs}}"));
  // Promptas NIEKADA argumentų vektoriuje: kitaip jis matytųsi procesų sąraše.
  assert.ok(!template.args.includes("{{prompt}}"));
  assert.equal(template.stdin, "{{prompt}}");
  assert.equal(template.stepLimit, AG_LOOP_STEP_LIMIT);
  assert.deepEqual([...template.forwardedEnvironment], ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.deepEqual(template.environment, {});
});

test("benchmarkCommand: metantis createAgentInvocations ir metantis runBenchmarkCommand — abu 5", async () => {
  const throwingFactory = async (): Promise<unknown> => ({
    createAgentInvocations: () => {
      throw new Error("bloga forma");
    },
    runBenchmarkCommand: async () => 0,
  });
  const first = captureIo();
  assert.equal(
    await benchmarkCommand(bridgeDeps({ load: throwingFactory, io: first.io }), []),
    BENCHMARK_INFRASTRUCTURE_EXIT_CODE,
  );
  assert.ok(first.err[0]?.includes("bloga forma"));

  const throwingRun = async (): Promise<unknown> => ({
    createAgentInvocations: () => ({}),
    runBenchmarkCommand: async () => {
      throw new Error("harness nukrito");
    },
  });
  const second = captureIo();
  assert.equal(
    await benchmarkCommand(bridgeDeps({ load: throwingRun, io: second.io }), []),
    BENCHMARK_INFRASTRUCTURE_EXIT_CODE,
  );
  assert.ok(second.err[0]?.includes("harness nukrito"));
});

// ---------------------------------------------------------------------------
// benchmark-drive
// ---------------------------------------------------------------------------

const DRIVE_ARGS = ["--workdir", ".", "--model", "claude-sonnet-5", "--step-limit", "40", "--timeout-ms", "1000"];

test("parseBenchmarkDriveArgs: trūkstamos vėliavos, nelaukiamas argumentas ir ne teigiamas sveikasis", () => {
  const missing = parseBenchmarkDriveArgs(["--workdir", "."]);
  assert.equal(missing.kind, "error");
  assert.ok(missing.kind === "error" && missing.message.includes("--model"));

  const unexpected = parseBenchmarkDriveArgs(["run"]);
  assert.ok(unexpected.kind === "error" && unexpected.message.includes("Unexpected argument: run"));

  const badInt = parseBenchmarkDriveArgs([...DRIVE_ARGS.slice(0, 5), "0", "--timeout-ms", "1000"]);
  assert.ok(badInt.kind === "error" && badInt.message.includes("--step-limit must be a positive integer"));

  const ok = parseBenchmarkDriveArgs(DRIVE_ARGS);
  if (ok.kind !== "ok") throw new Error(`parse nepavyko: ${ok.message}`);
  assert.equal(ok.args.stepLimit, 40);
  assert.equal(ok.args.timeoutMs, 1000);
  assert.equal(ok.args.promptFile, undefined);
});

function drivePorts(overrides: Partial<BenchmarkDrivePorts> = {}): BenchmarkDrivePorts {
  const result: BenchmarkDriveRunResult = { stdout: JSON.stringify({ is_error: false }), stderr: "", code: 0 };
  return {
    isDirectory: async () => true,
    readTextFile: async () => "prompt iš failo",
    readStdin: async () => "prompt iš stdin",
    runHeadless: async () => result,
    isUsageLimitOutput: () => false,
    extractUsage: () => ({ input_tokens: 10, output_tokens: 5, num_turns: 2 }),
    ...overrides,
  };
}

test("benchmarkDriveCommand: nesamas --workdir ir tuščias stdin — usage klaida be envelope", async () => {
  const first = captureIo();
  const noDir = await benchmarkDriveCommand({ ports: drivePorts({ isDirectory: async () => false }), io: first.io }, DRIVE_ARGS);
  assert.equal(noDir, 2);
  assert.equal(first.out.length, 0);
  assert.ok(first.err[0]?.includes("--workdir is not an existing directory"));

  const second = captureIo();
  const emptyStdin = await benchmarkDriveCommand({ ports: drivePorts({ readStdin: async () => "  " }), io: second.io }, DRIVE_ARGS);
  assert.equal(emptyStdin, 2);
  assert.equal(second.out.length, 0);
  assert.ok(second.err[0]?.includes("stdin prompt is empty"));
});

test("benchmarkDriveCommand: --prompt-file skaitomas per portą, tuščias failas — usage klaida", async () => {
  const { io, err } = captureIo();
  const ports = drivePorts({ readTextFile: async () => "\n" });
  const exit = await benchmarkDriveCommand({ ports, io }, [...DRIVE_ARGS, "--prompt-file", "p.md"]);
  assert.equal(exit, 2);
  assert.ok(err[0]?.includes("--prompt-file is empty"));
});

test("benchmarkDriveCommand: sėkmė — ag-loop/2 envelope su vienu LLM kvietimu ir usage bloku", async () => {
  const { io, out } = captureIo();
  let seenInput: { cwd: string; maxTurns: number; timeoutMs: number } | undefined;
  const ports = drivePorts({
    runHeadless: async (input) => {
      seenInput = { cwd: input.cwd, maxTurns: input.maxTurns, timeoutMs: input.timeoutMs };
      return { stdout: JSON.stringify({ is_error: false }), stderr: "", code: 0 };
    },
  });

  const exit = await benchmarkDriveCommand({ ports, io }, DRIVE_ARGS);
  assert.equal(exit, 0);
  assert.equal(seenInput?.maxTurns, 40);
  assert.equal(seenInput?.timeoutMs, 1000);
  assert.equal(norm(seenInput?.cwd ?? ""), norm(path.resolve(".")));

  const envelope = JSON.parse(out[0] ?? "{}") as Record<string, unknown>;
  assert.equal(envelope["agBenchmarkTelemetry"], 2);
  assert.equal(envelope["model"], "claude-sonnet-5");
  assert.equal(envelope["inputTokens"], 10);
  assert.equal(envelope["outputTokens"], 5);
  assert.equal(envelope["llmCalls"], 1);
  assert.equal(envelope["attempts"], 1);
  // repairs < attempts yra invariantas, kurį verifyLoopTelemetry tikrina skaitydamas atgal.
  assert.equal(envelope["repairs"], 0);
  assert.equal(envelope["claimedDone"], true);
  assert.deepEqual(envelope["usage"], { captured: true, numTurns: 2, turnsSource: "recorded" });
});

test("benchmarkDriveCommand: is_error envelope ir nenuskaityta usage — claimedDone false, nuliai", async () => {
  const { io, out } = captureIo();
  const ports = drivePorts({
    runHeadless: async () => ({ stdout: JSON.stringify({ is_error: true }), stderr: "", code: 0 }),
    extractUsage: () => undefined,
  });
  assert.equal(await benchmarkDriveCommand({ ports, io }, DRIVE_ARGS), 0);
  const envelope = JSON.parse(out[0] ?? "{}") as Record<string, unknown>;
  assert.equal(envelope["claimedDone"], false);
  assert.equal(envelope["inputTokens"], 0);
  assert.deepEqual(envelope["usage"], { captured: false });
});

test("benchmarkDriveCommand: 429 → 75, vaiko kodas propaguojamas — nė vienu atveju be envelope", async () => {
  const limited = captureIo();
  const limitPorts = drivePorts({ isUsageLimitOutput: () => true });
  assert.equal(await benchmarkDriveCommand({ ports: limitPorts, io: limited.io }, DRIVE_ARGS), 75);
  assert.equal(limited.out.length, 0);

  const failed = captureIo();
  const failPorts = drivePorts({
    runHeadless: async () => ({ stdout: "", stderr: "crash", code: 124 }),
  });
  assert.equal(await benchmarkDriveCommand({ ports: failPorts, io: failed.io }, DRIVE_ARGS), 124);
  assert.equal(failed.out.length, 0);
  assert.ok(failed.err[0]?.includes("claude exited 124: crash"));
});

// ---------------------------------------------------------------------------
// optimization-benchmark
// ---------------------------------------------------------------------------

const CONFIG_DOC = {
  version: 1,
  frozen_at: "2026-08-01",
  spec_source: "vq/project/token-optimization.md",
  primary_metric: "tokens_per_verified_accepted_change",
  token_basis: "total_tokens",
  comparison: { max_token_regression_pct: 10, require_same_config_hash: true, require_clean_integrity: true },
  cases: [
    {
      id: "core-loop",
      category: "core",
      description: "core loop tasks",
      size_class: "small",
      task_id_patterns: ["T-1*"],
      min_tasks: 1,
    },
  ],
};

const USAGE_LINES = [
  JSON.stringify({
    ts: "2026-08-01T00:00:00.000Z",
    phase: "dispatch",
    task_id: "T-10",
    model: "claude-sonnet-5",
    input_tokens: 100,
    output_tokens: 100,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: 0.1,
  }),
  JSON.stringify({
    ts: "2026-08-01T00:05:00.000Z",
    phase: "dispatch",
    task_id: "T-10",
    model: "claude-sonnet-5",
    input_tokens: 200,
    output_tokens: 200,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: 0.2,
  }),
].join("\n");

const EVENT_LINES = [
  JSON.stringify({ task_id: "T-10", to_state: "dispatched", reason: "" }),
  JSON.stringify({ task_id: "T-10", to_state: "done", reason: "verified" }),
].join("\n");

function benchmarkWorld(): { fs: BenchmarkCaptureFsPort; store: Map<string, string> } {
  const store = new Map<string, string>([
    [abs("vq/config/optimization-benchmark.json"), JSON.stringify(CONFIG_DOC)],
    [abs("vq/logs/token-usage.jsonl"), `${USAGE_LINES}\n`],
    [abs("vq/logs/task-events.jsonl"), `${EVENT_LINES}\n`],
  ]);
  return {
    store,
    fs: {
      readTextFileIfExists: async (p) => store.get(norm(p)),
      writeTextFile: async (p, content) => {
        store.set(norm(p), content);
      },
      makeDirectory: async () => {},
    },
  };
}

const NOW = new Date("2026-08-20T12:00:00.000Z");

test("optimizationBenchmarkCommand: --print-hash tekstu ir --json", async () => {
  const world = benchmarkWorld();
  const text = captureIo();
  assert.equal(
    await optimizationBenchmarkCommand({ fs: world.fs, runtimeRoot: RUNTIME_ROOT, now: NOW, io: text.io }, ["--print-hash"]),
    0,
  );
  assert.ok(text.out[0]?.startsWith("sha256:"));
  assert.ok(text.out[0]?.includes("version 1, frozen 2026-08-01"));

  const json = captureIo();
  assert.equal(
    await optimizationBenchmarkCommand({ fs: world.fs, runtimeRoot: RUNTIME_ROOT, now: NOW, io: json.io }, [
      "--print-hash",
      "--json",
    ]),
    0,
  );
  const parsed = JSON.parse(json.out.join("\n")) as { config_hash: string; config_version: number };
  assert.equal(parsed.config_version, 1);
  assert.ok(parsed.config_hash.startsWith("sha256:"));
});

test("optimizationBenchmarkCommand: report režimas — tekstinis renderis, --baseline rašo failą", async () => {
  const world = benchmarkWorld();
  const report = captureIo();
  const exit = await optimizationBenchmarkCommand(
    { fs: world.fs, runtimeRoot: RUNTIME_ROOT, now: NOW, io: report.io },
    [],
  );
  assert.equal(exit, 0);
  assert.ok(report.out[0]?.includes("tokens_per_verified_accepted_change"));

  const baseline = captureIo();
  assert.equal(
    await optimizationBenchmarkCommand({ fs: world.fs, runtimeRoot: RUNTIME_ROOT, now: NOW, io: baseline.io }, ["--baseline"]),
    0,
  );
  const written = world.store.get(abs("vq/project/optimization-baseline.md"));
  assert.ok(written?.includes("optimization-benchmark"));
  assert.ok(baseline.out.some((line) => line.startsWith("Baseline written: ")));
});

test("optimizationBenchmarkCommand: compare-baseline prieš identišką baseline — nulinės deltos, bet ne pagerėjimas, exit 1", async () => {
  const world = benchmarkWorld();
  const seed = captureIo();
  await optimizationBenchmarkCommand({ fs: world.fs, runtimeRoot: RUNTIME_ROOT, now: NOW, io: seed.io }, ["--baseline"]);

  const compare = captureIo();
  const exit = await optimizationBenchmarkCommand(
    { fs: world.fs, runtimeRoot: RUNTIME_ROOT, now: NOW, io: compare.io },
    ["--compare-baseline", "--json"],
  );
  // Exit kodas seka TIK success_declaration.allowed: identiškas run'as yra palyginamas ir be
  // regresijos, bet optimizacijos sėkme jis nėra — verdiktas ne "improved".
  assert.equal(exit, 1);
  const report = JSON.parse(compare.out.join("\n")) as {
    comparison: { comparable: boolean; token_delta_pct: number };
    success_declaration: { allowed: boolean };
  };
  assert.equal(report.comparison.comparable, true);
  assert.equal(report.comparison.token_delta_pct, 0);
  assert.equal(report.success_declaration.allowed, false);
});

test("optimizationBenchmarkCommand: nesamas konfigas, nežinomas argumentas ir režimų konfliktas — 2", async () => {
  const empty: BenchmarkCaptureFsPort = {
    readTextFileIfExists: async () => undefined,
    writeTextFile: async () => {},
    makeDirectory: async () => {},
  };
  const missing = captureIo();
  assert.equal(
    await optimizationBenchmarkCommand({ fs: empty, runtimeRoot: RUNTIME_ROOT, io: missing.io }, []),
    2,
  );
  assert.ok(missing.err[0]?.includes("optimization-benchmark config not found"));

  const world = benchmarkWorld();
  const unknown = captureIo();
  assert.equal(
    await optimizationBenchmarkCommand({ fs: world.fs, runtimeRoot: RUNTIME_ROOT, io: unknown.io }, ["--nope"]),
    2,
  );
  assert.ok(unknown.err[0]?.includes("Unknown optimization-benchmark argument"));

  const conflict = captureIo();
  assert.equal(
    await optimizationBenchmarkCommand({ fs: world.fs, runtimeRoot: RUNTIME_ROOT, io: conflict.io }, [
      "--baseline",
      "--print-hash",
    ]),
    2,
  );
  assert.ok(conflict.err[0]?.includes("mutually exclusive"));
});
