// `quality-gates` CLI adapterio argumentų kelias (pilnas auditas 2026-09-05, P1-C1; task 209).
//
// Task 209 norėjo, kad `qualityGatesCommand` pozicinį `[scope]` paverstų `--scope <x>`. Jis
// PARKUOTAS: `interfaces/hooks/stop-guards.ts:57` registruoja `quality-gates` kaip Stop guard'ą,
// o `composition/hooks/stop-adapters.ts:120` KIEKVIENĄ guard'ą paleidžia forma
// `[cli, <command>, "stop"]`. Tad Stop hook'as realiai kviečia `verqestra quality-gates stop`:
// bet kokia pozicinį suvartojanti normalizacija tą `"stop"` paverčia neteisingu scope'u ir
// nukerta Stop vartus visoms sesijoms (patikrinta — Stop blokas per 5 s, be statuso failo).
//
// Todėl čia fiksuojami tik tie kontraktai, kurie galioja NEPRIKLAUSOMAI nuo to, kaip 209 bus
// išspręstas. `["stop"]` atvejis yra regresijos smeigtukas: jis krinta būtent tada, kai kas nors
// vėl pabandys 209 be Stop guard'o kvietimo formos pataisymo.
import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_CHECK_COMMAND_CONTEXT } from "../domain/policies/check-command-allowlist.js";
import { qualityPolicySchema } from "../application/policy-governance/quality-policy.js";
import type { QualityGatesPorts } from "../application/quality-gates/quality-gates.js";
import type { QualityGatesStatus } from "../application/quality-gates/quality-gates-status.js";
import { qualityGatesCommand } from "../interfaces/cli/audit/quality-gates.js";
import type { CliIo } from "../interfaces/cli/registry.js";

type Harness = {
  deps: { ports: QualityGatesPorts; projectRoot: string; io: CliIo };
  statuses: QualityGatesStatus[];
  runnerCalls: string[];
  out: string[];
  errors: string[];
};

/**
 * Kiekvienam scope'ui — SKIRTINGA komanda, kad `status.commands` būtų nepriklausomas įrodymas,
 * jog nukeliauta į tą scope'ą, o ne tik `status.scope` lauko atkartojimas. Spawn forma: ji
 * praeina komandų politiką be papildomo konteksto, tad verdiktas priklauso tik nuo scope'o.
 */
function makeHarness(): Harness {
  const statuses: QualityGatesStatus[] = [];
  const runnerCalls: string[] = [];
  const out: string[] = [];
  const errors: string[] = [];

  const ports: QualityGatesPorts = {
    loadPolicy: async () =>
      qualityPolicySchema.parse({
        task: { checks: [{ cmd: "pnpm", args: ["test"] }] },
        feature: { checks: [{ cmd: "pnpm", args: ["lint"] }] },
        milestone: { checks: [{ cmd: "pnpm", args: ["build"] }] },
      }),
    commandContext: async () => EMPTY_CHECK_COMMAND_CONTEXT,
    runner: async (check) => {
      runnerCalls.push(check.display);
      return { code: 0, stdout: "", stderr: "" };
    },
    writeStatus: async (status) => void statuses.push(status),
    writeChecksLog: async () => {},
    loadLocalEnv: async () => ({}),
  };

  return {
    deps: {
      ports,
      projectRoot: "/repo",
      io: { out: (line) => void out.push(line), error: (line) => void errors.push(line) },
    },
    statuses,
    runnerCalls,
    out,
    errors,
  };
}

test("qualityGatesCommand: be argumentų — numatytasis task scope", async () => {
  const h = makeHarness();
  const exit = await qualityGatesCommand(h.deps, []);

  assert.equal(exit, 0);
  assert.equal(h.statuses[0]?.scope, "task");
  assert.deepEqual(h.runnerCalls, ["pnpm test"]);
  assert.match(h.out.join(""), /quality-gates scope=task PASSED/);
});

test("qualityGatesCommand: --scope vėliava nukeliauja iki komandų rinkimo", async () => {
  // `composition/quality/release-check-adapters.ts:111` paduoda būtent ["--scope","milestone"] —
  // šis atvejis yra release vartų kontraktas ir privalo išlikti bet kurioje 209 versijoje.
  const milestone = makeHarness();
  assert.equal(await qualityGatesCommand(milestone.deps, ["--scope", "milestone"]), 0);
  assert.equal(milestone.statuses[0]?.scope, "milestone");
  assert.deepEqual(milestone.runnerCalls, ["pnpm build"], "scope'as nukeliavo iki komandų rinkimo");

  const feature = makeHarness();
  assert.equal(await qualityGatesCommand(feature.deps, ["--scope", "feature"]), 0);
  assert.equal(feature.statuses[0]?.scope, "feature");
  assert.deepEqual(feature.runnerCalls, ["pnpm lint"]);

  const inline = makeHarness();
  assert.equal(await qualityGatesCommand(inline.deps, ["--scope=feature"]), 0);
  assert.equal(inline.statuses[0]?.scope, "feature");
});

test("qualityGatesCommand: Stop guard'o forma `quality-gates stop` lieka veikianti", async () => {
  // `stop-guards.ts:57` + `stop-adapters.ts:120`: Stop hook'as paleidžia `[cli, "quality-gates",
  // "stop"]`, nes mode token'ą prideda VISIEMS guard'ams. `"stop"` nėra scope ir niekada juo
  // nebuvo — jis privalo likti ignoruojamas, kitaip Stop vartai nukertami visoms sesijoms.
  const h = makeHarness();
  const exit = await qualityGatesCommand(h.deps, ["stop"]);

  assert.equal(exit, 0, "Stop guard'as laukia 0; bet koks kitas kodas blokuoja Stop hook'ą");
  assert.equal(h.statuses[0]?.scope, "task");
  assert.deepEqual(h.runnerCalls, ["pnpm test"]);
  assert.equal(h.errors.length, 0);
});

test("qualityGatesCommand: --json spausdina statusą su tikruoju scope'u", async () => {
  const h = makeHarness();
  const exit = await qualityGatesCommand(h.deps, ["--scope", "milestone", "--json"]);

  assert.equal(exit, 0);
  assert.equal(h.errors.length, 0);
  const parsed = JSON.parse(h.out.join("")) as QualityGatesStatus;
  assert.equal(parsed.scope, "milestone");
  assert.deepEqual(parsed.commands, ["pnpm build"]);
});
