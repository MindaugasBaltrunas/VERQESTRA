// VQ-502 (5/6-c) testai — PostToolUse rašymo pusė. Svarbiausia, ką jie pin'ina: TRYS praradimo
// žymės niekada nesulietos (ledger / nuosavybė / KPI), klasifikacija atsisako spėti (be signalo
// — `unknown`), KPI įvykis rašomas tik PIRMĄ kartą matomam keliui, o rašymai už repo ribų į
// ledger'į nepatenka.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  appendSessionFileEvent,
  classifySessionFileWrite,
  hookPostWrite,
  resolveWriterIdentity,
} from "../interfaces/hooks/post-write.js";
import { postHookContext, type PostHookDeps } from "../interfaces/hooks/post-hook-context.js";
import { fakePostHookWorld, type PostHookWorld } from "./helpers/post-hook-world.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const HOOKS_LOG = path.join(RUNTIME, "logs", "hooks.log");
const CHANGES_LOG = path.join(RUNTIME, "logs", "changes.log");
const LEDGER = path.join(RUNTIME, "state", "session-writes.json");
const OWNERS = path.join(RUNTIME, "state", "session-write-owners.json");
const EVENTS = path.join(RUNTIME, "state", "session-file-events.jsonl");
const CURRENT_TASK = path.join(RUNTIME, "state", "current-task-id");

function deps(world: PostHookWorld): PostHookDeps {
  return { ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME, io: world.io };
}

function writePayload(filePath: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath }, ...extra });
}

const eventLines = (world: PostHookWorld): unknown[] =>
  (world.store.get(EVENTS) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

// ---------------------------------------------------------------------------
// hookPostWrite — pilnas kelias
// ---------------------------------------------------------------------------

test("hookPostWrite: ledger'is, nuosavybė, KPI įvykis ir abu žurnalai vienu ėjimu", async () => {
  const world = fakePostHookWorld({
    stdin: writePayload(path.join(ROOT, "src", "a.ts"), { session_id: "sess-1" }),
    files: { [CURRENT_TASK]: "890\n" },
    env: { AG_DISPATCH_NONCE: "nonce-1" },
  });
  world.gitStatus.set("src/a.ts", { code: 0, stdout: "?? src/a.ts\n" });

  assert.equal(await hookPostWrite(deps(world)), 0);

  assert.deepEqual(JSON.parse(world.store.get(LEDGER) ?? "null"), ["src/a.ts"]);
  assert.deepEqual(JSON.parse(world.store.get(OWNERS) ?? "null"), {
    "src/a.ts": { sessions: ["nonce-1"], tasks: ["890"] },
  });
  assert.deepEqual(eventLines(world), [{ path: "src/a.ts", kind: "created", ts: eventTs(world) }]);
  assert.match(world.store.get(CHANGES_LOG) ?? "", /MODIFIED: /);
  assert.match(world.store.get(HOOKS_LOG) ?? "", /post-write: /);
});

function eventTs(world: PostHookWorld): string {
  const first = eventLines(world)[0] as { ts: string };
  return first.ts;
}

test("hookPostWrite: KPI įvykis ir git probe'as tik PIRMĄ kartą matomam keliui", async () => {
  const world = fakePostHookWorld({
    stdin: writePayload("src/a.ts"),
    env: { AG_DISPATCH_NONCE: "nonce-1" },
  });

  await hookPostWrite(deps(world));
  await hookPostWrite(deps(world));

  // Tą patį failą sesija perrašo dešimtis kartų; žurnalas turi po vieną eilutę keliui, o git
  // probe'as vienam failui įvyksta ne daugiau kaip kartą.
  assert.equal(eventLines(world).length, 1);
  assert.deepEqual(world.gitCalls, ["src/a.ts"]);
  assert.deepEqual(JSON.parse(world.store.get(LEDGER) ?? "null"), ["src/a.ts"]);
});

test("hookPostWrite: rašymai už repo ribų į ledger'į nepatenka", async () => {
  // Claude atminties failai nėra produkto pakeitimai; ledger'yje jie virsdavo klaidingu
  // out-of-scope human_review.
  const world = fakePostHookWorld({ stdin: writePayload("C:/Users/x/.claude/memory/a.md") });

  assert.equal(await hookPostWrite(deps(world)), 0);
  assert.equal(world.store.has(LEDGER), false);
  assert.equal(world.store.has(EVENTS), false);
  // Žurnalas vis tiek fiksuoja įvykį — nutylėti rašymo negalima.
  assert.match(world.store.get(HOOKS_LOG) ?? "", /post-write: /);
});

test("hookPostWrite: ledger'io gedimas ir sidecar'o gedimas turi ATSKIRAS žymes", async () => {
  const ledgerBroken = fakePostHookWorld({ stdin: writePayload("src/a.ts") });
  ledgerBroken.faults.write = new Error("EPERM rename");
  await hookPostWrite(deps(ledgerBroken));
  const ledgerLog = ledgerBroken.store.get(HOOKS_LOG) ?? "";
  assert.match(ledgerLog, /ledger_append_failed=1 path=src\/a\.ts/);
  assert.equal(ledgerLog.includes("owner_sidecar_failed"), false);

  // Sidecar'o gedimas reiškia prarastą TAPATYBĘ, ne prarastą darbą: kelias ledger'yje YRA, tad
  // `ledger_append_failed=1` čia meluotų diagnozei.
  const ownerBroken = fakePostHookWorld({
    stdin: writePayload("src/a.ts"),
    env: { AG_DISPATCH_NONCE: "nonce-1" },
  });
  ownerBroken.writeFailPaths.add(OWNERS);
  await hookPostWrite(deps(ownerBroken));
  const ownerLog = ownerBroken.store.get(HOOKS_LOG) ?? "";
  assert.match(ownerLog, /owner_sidecar_failed=1 path=src\/a\.ts/);
  assert.equal(ownerLog.includes("ledger_append_failed"), false);
  assert.deepEqual(JSON.parse(ownerBroken.store.get(LEDGER) ?? "null"), ["src/a.ts"]);
});

test("hookPostWrite: guard'ų fan-out'o gedimas neblokuoja ir nesustabdo hook'o", async () => {
  const world = fakePostHookWorld({ stdin: writePayload("src/a.ts") });
  const code = await hookPostWrite({
    ...deps(world),
    guards: {
      projectRoot: ROOT,
      runtimeRoot: RUNTIME,
      ports: {
        fs: world.ports.fs,
        guardRoots: () => {
          throw new Error("profilis nepasiekiamas");
        },
        runGuard: () => Promise.resolve(0),
      },
    },
  });
  assert.equal(code, 0);
});

// ---------------------------------------------------------------------------
// klasifikacija
// ---------------------------------------------------------------------------

test("classifySessionFileWrite: tool_response signalai laimi prieš įrankio vardą", async () => {
  const world = fakePostHookWorld();
  const context = postHookContext(deps(world));
  const classify = async (input: Record<string, unknown>): Promise<string> =>
    await classifySessionFileWrite(context, input, "src/a.ts");

  assert.equal(await classify({ tool_response: { type: "create" } }), "created");
  assert.equal(await classify({ tool_response: { type: "update" } }), "modified");
  assert.equal(await classify({ tool_response: { originalFile: "senas turinys" } }), "modified");
  assert.equal(await classify({ tool_response: { oldString: "x" } }), "modified");
  // Tuščia reikšmė nieko neįrodo — naujas failas irgi „tuščias".
  assert.equal(await classify({ tool_name: "Write", tool_response: { originalFile: "" } }), "modified");
});

test("classifySessionFileWrite: įrankio vardas, o `Write` — git status pakopa", async () => {
  const world = fakePostHookWorld();
  const context = postHookContext(deps(world));
  const classify = async (input: Record<string, unknown>): Promise<string> =>
    await classifySessionFileWrite(context, input, "src/a.ts");

  // Edit/NotebookEdit reikalauja egzistuojančio failo, tad sukurti jo negali.
  assert.equal(await classify({ tool_name: "Edit" }), "modified");
  assert.equal(await classify({ tool_name: "NotebookEdit" }), "modified");
  // Nežinomas įrankis (MCP rašytojas, tuščias vardas) nesako nieko — spėjimas draudžiamas.
  assert.equal(await classify({ tool_name: "mcp__writer" }), "unknown");
  assert.equal(await classify({}), "unknown");

  world.gitStatus.set("src/a.ts", { code: 0, stdout: "?? src/a.ts\n" });
  assert.equal(await classify({ tool_name: "Write" }), "created");
  world.gitStatus.set("src/a.ts", { code: 0, stdout: " M src/a.ts\n" });
  assert.equal(await classify({ tool_name: "Write" }), "modified");
  // `!!` = gitignore'intas kelias: git apie jo istoriją nieko nežino, tad `unknown`, ne spėjimas.
  world.gitStatus.set("src/a.ts", { code: 0, stdout: "!! src/a.ts\n" });
  assert.equal(await classify({ tool_name: "Write" }), "unknown");
  // Nėra repo / nėra git / procesas metė — irgi „nežinau".
  world.gitStatus.set("src/a.ts", { code: 128, stdout: "" });
  assert.equal(await classify({ tool_name: "Write" }), "unknown");
});

// ---------------------------------------------------------------------------
// KPI įvykių žurnalas ir tapatybė
// ---------------------------------------------------------------------------

test("appendSessionFileEvent: neįgytas lock'as prarandamas TYLIAI su sava žyme", async () => {
  const world = fakePostHookWorld({ files: { [`${EVENTS}.lock`]: "kitas-1-1 2026-08-21T00:00:00.000Z\n" } });
  const context = postHookContext(deps(world));

  const result = await appendSessionFileEvent(
    context,
    EVENTS,
    { path: "src/a.ts", kind: "created", ts: "2026-08-21T00:00:00.000Z" },
    60,
  );
  assert.equal(result.appended, false);
  assert.match(result.failure ?? "", /lock not acquired within 60ms/);
  assert.equal(world.store.has(EVENTS), false);
});

test("appendSessionFileEvent: sėkmė prideda vieną JSONL eilutę ir atlaisvina savo lock'ą", async () => {
  const world = fakePostHookWorld();
  const context = postHookContext(deps(world));
  const event = { path: "src/a.ts", kind: "created" as const, ts: "2026-08-21T00:00:00.000Z" };

  assert.deepEqual(await appendSessionFileEvent(context, EVENTS, event), { appended: true });
  assert.deepEqual(eventLines(world), [event]);
  assert.equal(world.store.has(`${EVENTS}.lock`), false);
});

test("resolveWriterIdentity: nonce neša task'ą, o interaktyvi sesija — niekada", async () => {
  const dispatched = fakePostHookWorld({
    files: { [CURRENT_TASK]: " 890 \n" },
    env: { AG_DISPATCH_NONCE: "nonce-1" },
  });
  assert.deepEqual(await resolveWriterIdentity(postHookContext(deps(dispatched)), {}), {
    session: "nonce-1",
    taskId: "890",
  });

  // Interaktyvi sesija mato TĄ PATĮ globalų current-task-id, tad jos rašymų žymėjimas task'u
  // svetimą WIP vėl paverstų šio task'o darbu — būtent tai, ką tapatybė ir turi atskirti.
  const interactive = fakePostHookWorld({ files: { [CURRENT_TASK]: "890\n" } });
  assert.deepEqual(await resolveWriterIdentity(postHookContext(deps(interactive)), { session_id: "sess-9" }), {
    session: "session:sess-9",
    taskId: "",
  });

  // Nei nonce, nei session_id — tuščia tapatybė, kuri sidecar'e NIEKADA nerašoma.
  const anonymous = fakePostHookWorld();
  assert.deepEqual(await resolveWriterIdentity(postHookContext(deps(anonymous)), {}), { session: "", taskId: "" });
});
