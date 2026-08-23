// VQ-502 (6/6-c) testai — Stop pre-commit guard'ai. Svarbiausia, ką jie pin'ina: guard'ai bėga
// LYGIAGREČIAI, bet pirmoji nesėkmė pranešama FIKSUOTA registro tvarka (blokavimo priežastis
// negali priklausyti nuo to, kuris subprocesas grįžo pirmas), nesamai produkto šakniai skirtas
// guard'as nepaleidžiamas, o NEPALEISTAS guard'as niekada nelaikomas praėjusiu.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookFsPort } from "../interfaces/hooks/protocol.js";
import { PRE_COMMIT_STOP_GUARDS, runStopGuards, type StopGuardPorts } from "../interfaces/hooks/stop-guards.js";

const ROOT = "/repo";

type GuardWorld = { ports: StopGuardPorts; started: string[] };

function guardWorld(options: { roots?: string[]; codes?: Record<string, number>; failing?: Set<string> } = {}): GuardWorld {
  const existingRoots = new Set(options.roots ?? []);
  const started: string[] = [];
  const fs: HookFsPort = {
    exists: async (p) => [...existingRoots].some((root) => p.endsWith(root)),
    readTextFileIfExists: async () => undefined,
    writeTextFile: async () => {},
    appendTextFile: async () => {},
    makeDirectory: async () => {},
  };
  return {
    started,
    ports: {
      fs,
      guardRoots: async () => ({ frontend: "apps/web", backend: "apps/api", mobile: "apps/mobile" }),
      runGuard: async () => 0,
      runStopGuard: async (command) => {
        started.push(command);
        if (options.failing?.has(command)) throw new Error(`${command} nepasileido`);
        return options.codes?.[command] ?? 0;
      },
    },
  };
}

test("PRE_COMMIT_STOP_GUARDS: deklaruota prioriteto tvarka yra kontraktas", () => {
  assert.deepEqual(PRE_COMMIT_STOP_GUARDS.map((guard) => guard.command), [
    "hook-secret-scan",
    "hook-package-guard",
    "hook-migration-guard",
    "hook-frontend-guard",
    "hook-backend-guard",
    "hook-mobile-guard",
    "quality-gates",
  ]);
});

test("runStopGuards: visi žali — nesėkmės nėra, o produkto guard'ai be šaknų nepaleidžiami", async () => {
  const world = guardWorld();
  assert.equal(await runStopGuards(world.ports, ROOT), undefined);
  // Be `apps/web|api|mobile` šaknų lieka tik universalūs guard'ai.
  assert.deepEqual(world.started.sort(), [
    "hook-migration-guard",
    "hook-package-guard",
    "hook-secret-scan",
    "quality-gates",
  ]);

  const withFrontend = guardWorld({ roots: ["apps/web"] });
  await runStopGuards(withFrontend.ports, ROOT);
  assert.equal(withFrontend.started.includes("hook-frontend-guard"), true);
  assert.equal(withFrontend.started.includes("hook-backend-guard"), false);
});

test("runStopGuards: nesėkmė pranešama REGISTRO tvarka, ne užbaigimo eile", async () => {
  // Abu krenta; blokavimo priežastis privalo būti aukštesnio prioriteto guard'o, nesvarbu,
  // kad `quality-gates` grįžta pirmas.
  const world = guardWorld({ codes: { "quality-gates": 2, "hook-package-guard": 2 } });
  const failure = await runStopGuards(world.ports, ROOT);
  assert.equal(failure?.guard.command, "hook-package-guard");
  assert.equal(failure?.guard.blockReason, "package guard blocked stop");
  // Visi guard'ai vis tiek buvo paleisti — jie nepriklausomi ir bėga lygiagrečiai.
  assert.equal(world.started.length, 4);
});

test("runStopGuards: nepaleistas guard'as NIEKADA nelaikomas praėjusiu", async () => {
  // Sugedusi aplinka (nėra CLI, EACCES) kitaip tyliai atidarytų visus vartus.
  const world = guardWorld({ failing: new Set(["hook-secret-scan"]) });
  const failure = await runStopGuards(world.ports, ROOT);
  assert.equal(failure?.guard.command, "hook-secret-scan");
});

test("runStopGuards: registro pjūvis leidžia paleisti siauresnį rinkinį ta pačia tvarka", async () => {
  const world = guardWorld({ codes: { "quality-gates": 1 } });
  const only = PRE_COMMIT_STOP_GUARDS.filter((guard) => guard.command === "quality-gates");
  const failure = await runStopGuards(world.ports, ROOT, only);

  assert.equal(failure?.guard.blockReason, "quality gates blocked stop");
  assert.deepEqual(world.started, ["quality-gates"]);
});
