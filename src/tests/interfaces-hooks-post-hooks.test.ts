// VQ-502 (5/6-c) testai — PostToolUse Bash ir Read pusė. Svarbiausia, ką jie pin'ina: hook'as
// NIEKADA neblokuoja (visada 0, net kai portai meta), išjungta kompresijos vėliava yra tikras
// no-op, neperskaitomas payload'as į žurnalą patenka KIND'u (ne parserio žinute, kuri neša
// komandos tekstą), o readme įrodymo lock politika yra fail-OPEN.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { ContextCompressionConfig } from "../domain/policies/compression/features.js";
import {
  buildPostToolUseHookOutput,
  evaluatePostBashSync,
  hookPostBash,
  hookPostBashSync,
  hookPostRead,
} from "../interfaces/hooks/post-hooks.js";
import type { PostHookDeps, PostHookPorts } from "../interfaces/hooks/post-hook-context.js";
import { fakePostHookWorld, type PostHookWorld } from "./helpers/post-hook-world.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const HOOKS_LOG = path.join(RUNTIME, "logs", "hooks.log");
const READ_EVENTS = path.join(RUNTIME, "state", "readme-read-events.json");
const SHADOW_LOG = path.join(RUNTIME, "logs", "bash-digest-shadow.jsonl");
const REPLACEMENT_LOG = path.join(RUNTIME, "logs", "bash-digest-replacement.jsonl");

const LONG_OUTPUT = `${"ok 1 - a\n".repeat(120)}# pass 120\n# fail 0\n`;

function digestOn(): ContextCompressionConfig {
  return { features: { bash_output_digest: true } } as unknown as ContextCompressionConfig;
}

function deps(world: PostHookWorld, overrides: Partial<PostHookPorts> = {}): PostHookDeps {
  return {
    ports: { ...world.ports, ...overrides },
    projectRoot: ROOT,
    runtimeRoot: RUNTIME,
    io: world.io,
  };
}

// ---------------------------------------------------------------------------
// hookPostBash — shadow telemetrija
// ---------------------------------------------------------------------------

test("hookPostBash: žurnalas rašomas visada, o shadow eilutė — tik su įjungta vėliava", async () => {
  const off = fakePostHookWorld({ stdin: JSON.stringify({ tool_input: { command: "pnpm test" } }) });
  assert.equal(await hookPostBash(deps(off)), 0);
  assert.match(off.store.get(HOOKS_LOG) ?? "", /post-bash: pnpm test/);
  assert.equal(off.store.has(SHADOW_LOG), false, "išjungta vėliava — tikras no-op");

  const on = fakePostHookWorld({
    stdin: JSON.stringify({
      tool_input: { command: "pnpm test" },
      tool_response: { stdout: LONG_OUTPUT, stderr: "", exit_code: 0 },
    }),
    config: digestOn(),
  });
  assert.equal(await hookPostBash(deps(on)), 0);
  const record = JSON.parse((on.store.get(SHADOW_LOG) ?? "").trim()) as Record<string, unknown>;
  assert.equal(typeof record["ts"], "string");
});

test("hookPostBash: konfigo ir žurnalo gedimai negali užblokuoti tool call'o", async () => {
  const world = fakePostHookWorld({ stdin: JSON.stringify({ tool_input: { command: "pnpm test" } }) });
  world.faults.append = new Error("EACCES vq/logs");

  // Kiekvienas kelias — konfigo skaitymas, telemetrijos rašymas, žurnalo eilutė — čia meta,
  // o PostToolUse hook'e išimtis reikštų exit 2, t. y. UŽBLOKUOTĄ įrankio kvietimą.
  const code = await hookPostBash(
    deps(world, {
      loadCompressionConfig: async () => {
        throw new Error("sugadintas konfigas");
      },
    }),
  );
  assert.equal(code, 0);
});

// ---------------------------------------------------------------------------
// evaluatePostBashSync — sprendimo pusė
// ---------------------------------------------------------------------------

test("evaluatePostBashSync: išjungta vėliava neduoda nei voko, nei žurnalo eilutės", async () => {
  const world = fakePostHookWorld();
  const outcome = await evaluatePostBashSync(deps(world), JSON.stringify({ tool_name: "Bash" }));
  assert.deepEqual(outcome, {});
  assert.equal(world.store.has(REPLACEMENT_LOG), false);
});

test("evaluatePostBashSync: įrodytas perrašymas duoda voką, o žurnalas fiksuoja sprendimą", async () => {
  const world = fakePostHookWorld({ config: digestOn() });
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    tool_response: { stdout: LONG_OUTPUT, stderr: "", exit_code: 0 },
  });

  const outcome = await evaluatePostBashSync(deps(world), payload);
  assert.ok(outcome.hookOutput, "perrašymas privalo duoti voką");
  assert.equal(outcome.hookOutput?.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(outcome.hookOutput?.suppressOutput, true);
  assert.equal(outcome.record?.action, "replace");
  assert.equal((world.store.get(REPLACEMENT_LOG) ?? "").trim().split("\n").length, 1);
});

test("evaluatePostBashSync: neperskaitomas payload'as fiksuojamas KIND'u, be komandos teksto", async () => {
  const world = fakePostHookWorld({ config: digestOn() });
  const outcome = await evaluatePostBashSync(deps(world), "{ nebaigtas JSON su slaptu tekstu");

  assert.equal(outcome.hookOutput, undefined, "neperskaitytas payload'as niekada neperrašomas");
  const line = (world.store.get(REPLACEMENT_LOG) ?? "").trim();
  // Parserio žinutė Node 20+ įterpia įvesties fragmentą — t. y. komandos eilutę ir jos išvestį.
  // Šio žurnalo visas kontraktas yra tas, kad jis neneša nei vieno, nei kito.
  assert.equal(line.includes("slaptu tekstu"), false);
  assert.match(line, /unreadable_hook_input/);
});

test("hookPostBashSync: spausdina lygiai vieną eilutę, o be perrašymo tyli", async () => {
  const withReplacement = fakePostHookWorld({
    config: digestOn(),
    stdin: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { stdout: LONG_OUTPUT, stderr: "", exit_code: 0 },
    }),
  });
  assert.equal(await hookPostBashSync(deps(withReplacement)), 0);
  assert.equal(withReplacement.out.length, 1);
  assert.equal(JSON.parse(withReplacement.out[0] ?? "null").suppressOutput, true);

  // Tuščia išvestis yra vienareikšmis „neturiu nuomonės" signalas; tuščias JSON objektas būtų
  // dar vienas dalykas, kurį Claude Code build'as turi interpretuoti.
  const silent = fakePostHookWorld({ stdin: JSON.stringify({ tool_name: "Bash" }) });
  assert.equal(await hookPostBashSync(deps(silent)), 0);
  assert.deepEqual(silent.out, []);

  // Net stdin gedimas lieka tyla, o ne blokuojantis exit kodas.
  const broken = fakePostHookWorld();
  assert.equal(
    await hookPostBashSync(
      deps(broken, {
        stdin: {
          readStdin: async () => {
            throw new Error("EPIPE");
          },
        },
      }),
    ),
    0,
  );
});

test("buildPostToolUseHookOutput: voko forma yra vienoje vietoje", () => {
  assert.deepEqual(buildPostToolUseHookOutput({ stdout: "x" }), {
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout: "x" } },
    suppressOutput: true,
  });
});

// ---------------------------------------------------------------------------
// hookPostRead — readme įrodymai
// ---------------------------------------------------------------------------

test("hookPostRead: absoliutus kelias virsta repo forma ir patenka į įrodymų failą", async () => {
  const world = fakePostHookWorld({
    stdin: JSON.stringify({ tool_input: { file_path: path.join(ROOT, "src", "app.ts") } }),
  });

  assert.equal(await hookPostRead(deps(world)), 0);
  assert.deepEqual(JSON.parse(world.store.get(READ_EVENTS) ?? "null"), ["src/app.ts"]);
  assert.match(world.store.get(HOOKS_LOG) ?? "", /post-read: src\/app\.ts/);
});

test("hookPostRead: tuščias kelias nieko nerašo", async () => {
  const world = fakePostHookWorld({ stdin: JSON.stringify({ tool_input: {} }) });
  assert.equal(await hookPostRead(deps(world)), 0);
  assert.equal(world.store.has(READ_EVENTS), false);
  assert.equal(world.store.has(HOOKS_LOG), false);
});

test("hookPostRead: po lock deadline'o įrašas VIS TIEK rašomas ir pažymimas degradavusiu", async () => {
  // Politika APVERSTA lyginant su ledger'iu: prarastas readme įrodymas uždaro pre-write vartus
  // grandinės viduryje, o agentas jų atidaryti nebegali — to failo rašymas per įrankius
  // uždraustas.
  const world = fakePostHookWorld({
    stdin: JSON.stringify({ tool_input: { file_path: "README.md" } }),
    files: { [`${READ_EVENTS}.lock`]: "kitas-1-1 2026-08-21T00:00:00.000Z\n" },
  });

  assert.equal(await hookPostRead({ ...deps(world), readEventLockWaitMs: 60 }), 0);
  assert.deepEqual(JSON.parse(world.store.get(READ_EVENTS) ?? "null"), ["README.md"]);
  assert.match(world.store.get(HOOKS_LOG) ?? "", /read_event_unlocked_append=1 path=README\.md/);
});
