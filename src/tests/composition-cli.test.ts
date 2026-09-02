// VQ-504 (1/N) testai — CLI dispatch'as ir kompozicijos šaknys. Svarbiausia, ką jie pin'ina:
// nežinoma komanda yra USAGE klaida (2), ne 1; registro dublikatas sustabdo dispatch'ą PRIEŠ
// vykdymą; komandos išimtis niekada neišeina pro CLI kraštą, o infrastruktūros errno gauna SAVO
// kodą; `help` rodo TIK realiai surištas komandas.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLI_VERSION, runCli } from "../composition/cli/main.js";
import { buildCliCommands, renderCliHelp } from "../composition/cli/registry.js";
import { PROJECT_DIR_ENV, resolveRuntimeRoots } from "../composition/runtime/context.js";
import { taskRunPorts } from "../composition/loop/coordinator-execution-adapters.js";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import type { CliCommand, CliIo } from "../interfaces/cli/registry.js";
import { INFRASTRUCTURE_IO_EXIT_CODE, USAGE_ERROR_EXIT_CODE, USAGE_LIMIT_EXIT_CODE } from "../shared/exit-codes.js";
import { WorkflowInfrastructureError } from "../shared/errors.js";

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

function command(name: string, run: CliCommand["run"]): CliCommand {
  return { name, description: `${name} testui`, run };
}

test("resolveRuntimeRoots: aplinka nugali cwd, o runtime šaknys išvedamos iš projekto", () => {
  const fromEnv = resolveRuntimeRoots({
    env: (name) => (name === PROJECT_DIR_ENV ? "/repo" : undefined),
    cwd: () => "/kitas",
  });
  assert.equal(fromEnv.projectRoot, path.resolve("/repo"));
  assert.equal(fromEnv.runtimeRoot, path.join(path.resolve("/repo"), "vq"));
  assert.equal(fromEnv.agRoot, path.join(path.resolve("/repo"), "AG"));

  // Hook'as vykdomas iš nenuspėjamo katalogo, tad be aplinkos `cwd` yra vienintelis šaltinis.
  const fromCwd = resolveRuntimeRoots({ env: () => undefined, cwd: () => "/darbinis" });
  assert.equal(fromCwd.projectRoot, path.resolve("/darbinis"));
  // Tuščia aplinkos reikšmė nėra nurodymas.
  const blank = resolveRuntimeRoots({ env: () => "   ", cwd: () => "/darbinis" });
  assert.equal(blank.projectRoot, path.resolve("/darbinis"));
});

test("runCli: be argumentų ir su `help` rodomas registras, o ne klaida", async () => {
  const world = captureIo();
  const commands = [command("alfa", () => 0), command("beta", () => 0)];

  assert.equal(await runCli({ commands, io: world.io }, []), 0);
  assert.match(world.out.join("\n"), /Usage: verqestra <command>/);
  assert.match(world.out.join("\n"), /alfa — alfa testui/);

  assert.equal(await runCli({ commands, io: world.io }, ["--help"]), 0);
  assert.equal(await runCli({ commands, io: world.io }, ["version"]), 0);
  assert.equal(world.out.includes(CLI_VERSION), true);
});

test("runCli: nežinoma komanda yra USAGE klaida su nuoroda į help", async () => {
  const world = captureIo();
  const code = await runCli({ commands: [command("alfa", () => 0)], io: world.io }, ["nera"]);

  assert.equal(code, USAGE_ERROR_EXIT_CODE);
  assert.match(world.err.join("\n"), /Unknown command: nera/);
  assert.match(world.err.join("\n"), /verqestra help/);
});

test("runCli: dublikuotas registro vardas sustabdo dispatch'ą PRIEŠ vykdymą", async () => {
  const world = captureIo();
  let ran = 0;
  const commands = [command("alfa", () => ++ran), command("alfa", () => ++ran)];

  const code = await runCli({ commands, io: world.io }, ["alfa"]);
  assert.equal(code, 1);
  assert.equal(ran, 0, "tylus nugalėtojas priklausytų nuo deklaravimo tvarkos");
  assert.match(world.err.join("\n"), /duplicate command name: alfa/);
});

test("runCli: argumentai perduodami be komandos vardo, o kodas grąžinamas kaip yra", async () => {
  const world = captureIo();
  let received: string[] = [];
  const commands = [
    command("alfa", (args) => {
      received = args;
      return 3;
    }),
  ];

  assert.equal(await runCli({ commands, io: world.io }, ["alfa", "--flag", "reikšmė"]), 3);
  assert.deepEqual(received, ["--flag", "reikšmė"]);
});

test("runCli: komandos išimtis NEIŠEINA pro kraštą, o aplinkos errno gauna savo kodą", async () => {
  const world = captureIo();
  const generic = await runCli(
    {
      commands: [
        command("alfa", () => {
          throw new Error("netikėta");
        }),
      ],
      io: world.io,
    },
    ["alfa"],
  );
  assert.equal(generic, 1);
  assert.match(world.err.join("\n"), /alfa: netikėta/);

  // Aplinkos gedimas turi būti atskirtas nuo užduoties nesėkmės — orkestratorius juos vertina
  // skirtingai.
  const errno = Object.assign(new Error("EACCES: permission denied"), {
    code: "EACCES",
    errno: -13,
    syscall: "open",
  });
  const infrastructure = await runCli(
    {
      commands: [
        command("alfa", () => {
          throw errno;
        }),
      ],
      io: captureIo().io,
    },
    ["alfa"],
  );
  assert.equal(infrastructure, INFRASTRUCTURE_IO_EXIT_CODE);
});

test("runCli: WorkflowInfrastructureError su exitCode grąžina TĄ patį kodą tėvo ribai, o be jo lieka UNEXPECTED", async () => {
  const withExitCode = await runCli(
    {
      commands: [
        command("alfa", () => {
          throw new WorkflowInfrastructureError("usage limit", { exitCode: USAGE_LIMIT_EXIT_CODE });
        }),
      ],
      io: captureIo().io,
    },
    ["alfa"],
  );
  assert.equal(withExitCode, USAGE_LIMIT_EXIT_CODE);

  const withoutExitCode = await runCli(
    {
      commands: [
        command("alfa", () => {
          throw new WorkflowInfrastructureError("nežinoma infra priežastis");
        }),
      ],
      io: captureIo().io,
    },
    ["alfa"],
  );
  assert.equal(withoutExitCode, 1);
});

test("buildCliCommands: registras neša tik REALIAI surištas komandas", () => {
  const roots = resolveRuntimeRoots({ env: () => "/repo" });
  const commands = buildCliCommands({ roots });

  assert.deepEqual(
    commands.map((entry) => entry.name),
    [
      "export-json-schema",
      "export-api-contract",
      "learning",
      "plan",
      "task-generate",
      "spec-drift",
      "openspec-reconcile",
      "task-ledger-sync",
      "task-move",
      "requeue",
      "status",
      "process-queued-task",
      "task-dependencies",
      "backlog-audit",
      "security-verify",
      "release-notes",
      "quality-gates",
      "converge",
      "readiness-audit",
      "audit-director",
      "final-audit",
      "preflight",
      "policy",
      "agent",
      "project-status",
      "report",
      "build-gate",
      "milestone-check",
      "release-check",
      "project-mode",
      "ui",
      "bootstrap-project",
      "compound-init",
      "install",
      "smoke",
      "restore-stable",
      "rollback-stable",
      "claude-dispatch",
      "claude-preflight",
      "claude-diagnose",
      "loop",
      "loop-guard",
      "dispatch",
      "codex-dispatch",
      "retry-guard",
      "on-stop-bridge",
      "code-index",
      "code-graph",
      "context-pack",
      "architecture",
      "benchmark",
      "benchmark-drive",
      "benchmark-loop-cell",
      "optimization-benchmark",
      "github-issue-import",
      "github-pr",
      "hook-pre-bash",
      "hook-pre-write",
      "hook-post-bash",
      "hook-post-bash-sync",
      "hook-post-read",
      "hook-post-write",
      "hook-secret-scan",
      "hook-package-guard",
      "hook-migration-guard",
      "hook-backend-guard",
      "hook-frontend-guard",
      "hook-mobile-guard",
      "hook-session-start",
      "hook-session-end",
      "hook-session-summary",
      "hook-user-prompt",
      "hook-on-stop",
    ],
  );
  // Rodyti komandą, kurios dispatch'as nepasiekia, reikštų meluoti operatoriui.
  assert.equal(
    renderCliHelp(commands).some((line) => line.includes("export-json-schema [--out <dir>]")),
    true,
  );
});

test("095-b-03: taskRunPorts.rules.hasAuditCompleteMarker atpažįsta AUDIT_COMPLETE tiek žaliame, tiek stream-json log'e", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-coord-auditmarker-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  const agRoot = path.join(projectRoot, "AG");
  try {
    const ports = taskRunPorts({
      projectRoot,
      runtimeRoot,
      agRoot,
      resolution: noRuntimeAttemptResolution,
      runCli: async () => 0,
      runCliCaptured: async () => ({ code: 0, output: "" }),
    });

    assert.equal(typeof ports.rules.hasAuditCompleteMarker, "function");
    assert.equal(ports.rules.hasAuditCompleteMarker?.("AUDIT_COMPLETE: nieko taisytino nerasta"), true);
    assert.equal(ports.rules.hasAuditCompleteMarker?.("kažkas kita, jokio markerio"), false);

    const resultLine = JSON.stringify({
      type: "result",
      result: "eiga...\nAUDIT_COMPLETE: 12 failų patikrinta, radinių nėra\n",
    });
    assert.equal(ports.rules.hasAuditCompleteMarker?.(`${resultLine}\n`), true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("021-d-05: taskRunPorts.cli.run laukia SAVO stop-bridge įrodymo PRIEŠ quality-gates (own-done greitai, timeout nekeičia elgesio)", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-coord-stopwait-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  const agRoot = path.join(projectRoot, "AG");
  const orchestratorLog = path.join(runtimeRoot, "logs", "orchestrator.log");
  const readLog = async () => (await nodeFsAdapter.readTextFileIfExists(orchestratorLog)) ?? "";

  let qualityGatesRuns = 0;
  const ports = taskRunPorts({
    projectRoot,
    runtimeRoot,
    agRoot,
    resolution: noRuntimeAttemptResolution,
    runCli: async (args) => {
      if (args[0] === "quality-gates") qualityGatesRuns += 1;
      return 0;
    },
    runCliCaptured: async () => ({ code: 0, output: "" }),
  });

  const previousNonce = process.env["AG_DISPATCH_NONCE"];
  const previousWaitMs = process.env["AG_DISPATCH_STOP_WAIT_MS"];
  try {
    // a) be nonce (interaktyvi/be-dispatch sesija) — pass-through, jokio laukimo žurnalo.
    delete process.env["AG_DISPATCH_NONCE"];
    assert.equal(await ports.cli.run(["quality-gates"]), 0);
    assert.equal(qualityGatesRuns, 1);
    assert.equal((await readLog()).includes("COORDINATOR STOP WAIT"), false);

    // b) own-done: globalus stop failas su MŪSŲ nonce parašytas PRIEŠ kvietimą — sulaukiama
    // iškart (pirmas probe), be jokio realaus miego.
    process.env["AG_DISPATCH_NONCE"] = "nonce-1";
    await nodeFsAdapter.writeTextFile(path.join(runtimeRoot, "state", "current-task-id"), "0042\n");
    await nodeFsAdapter.writeTextFile(
      path.join(runtimeRoot, "state", "claude-stop-status.json"),
      JSON.stringify({ status: "done", dispatch_nonce: "nonce-1", task_id: "0042" }),
    );
    assert.equal(await ports.cli.run(["quality-gates"]), 0);
    assert.equal(qualityGatesRuns, 2);
    assert.match(
      await readLog(),
      /COORDINATOR STOP WAIT RESULT: task=0042 result=own-done classification=own-done source=global/,
    );

    // c) timeout: langas išjungtas (AG_DISPATCH_STOP_WAIT_MS=0 — explicit opt-out, vienas
    // probe), stop failo įrodymo nebėra — verdiktas lieka `none`, o cli.run vis tiek įvyksta
    // (timeout NIEKADA nepakeičia baigties).
    process.env["AG_DISPATCH_STOP_WAIT_MS"] = "0";
    await nodeFsAdapter.writeTextFile(path.join(runtimeRoot, "state", "claude-stop-status.json"), "");
    assert.equal(await ports.cli.run(["quality-gates"]), 0);
    assert.equal(qualityGatesRuns, 3);
    assert.match(
      await readLog(),
      /COORDINATOR STOP WAIT RESULT: task=0042 result=timeout classification=none source=none/,
    );

    // d) kiti cli.run argumentai (pvz. preflight) — laukimas neliečiamas net su gyvu nonce.
    const linesBefore = (await readLog()).split("\n").length;
    assert.equal(await ports.cli.run(["claude-preflight", "AG/tasks/active/0042.md"]), 0);
    assert.equal((await readLog()).split("\n").length, linesBefore, "kiti args nekviečia stop-bridge laukimo");
  } finally {
    if (previousNonce === undefined) delete process.env["AG_DISPATCH_NONCE"];
    else process.env["AG_DISPATCH_NONCE"] = previousNonce;
    if (previousWaitMs === undefined) delete process.env["AG_DISPATCH_STOP_WAIT_MS"];
    else process.env["AG_DISPATCH_STOP_WAIT_MS"] = previousWaitMs;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
