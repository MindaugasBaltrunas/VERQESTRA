// VQ-504 (1/N) testai — CLI dispatch'as ir kompozicijos šaknys. Svarbiausia, ką jie pin'ina:
// nežinoma komanda yra USAGE klaida (2), ne 1; registro dublikatas sustabdo dispatch'ą PRIEŠ
// vykdymą; komandos išimtis niekada neišeina pro CLI kraštą, o infrastruktūros errno gauna SAVO
// kodą; `help` rodo TIK realiai surištas komandas.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { CLI_VERSION, runCli } from "../composition/cli-main.js";
import { buildCliCommands, renderCliHelp } from "../composition/cli-registry.js";
import { PROJECT_DIR_ENV, resolveRuntimeRoots } from "../composition/runtime-context.js";
import type { CliCommand, CliIo } from "../interfaces/cli/registry.js";
import { INFRASTRUCTURE_IO_EXIT_CODE, USAGE_ERROR_EXIT_CODE } from "../shared/exit-codes.js";

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
    ],
  );
  // Rodyti komandą, kurios dispatch'as nepasiekia, reikštų meluoti operatoriui.
  assert.equal(
    renderCliHelp(commands).some((line) => line.includes("export-json-schema [--out <dir>]")),
    true,
  );
});
