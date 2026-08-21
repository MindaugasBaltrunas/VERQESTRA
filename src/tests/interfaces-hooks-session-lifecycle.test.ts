// VQ-502 (6/6-b) testai — SessionStart/SessionEnd. Svarbiausia, ką jie pin'ina: TRYS
// nepriklausomi reset'o stabdžiai (continuation, tas pats bandymas pagal nonce, gyvas svetimas
// dispatch'as), dispatch'inta sesija NIEKADA neliečia vartotojo terminalo indikatoriaus, o
// SessionEnd skaičiuoja iš nuotraukos, kuri pergyvena Stop hook'o changes.log valymą.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { DispatchCheckpointView } from "../application/task-execution/session-baseline.js";
import {
  hookSessionStart,
  isSessionContinuation,
  registerUserClaudeRuntime,
} from "../interfaces/hooks/session-start.js";
import { hookSessionEnd, releaseUserClaudeRuntime } from "../interfaces/hooks/session-end.js";
import {
  type SessionHookDeps,
  type SessionHookPorts,
  sessionHookContext,
  userClaudePidFile,
} from "../interfaces/hooks/session-hook-context.js";
import { loopRuntimeRecordPath } from "../interfaces/hooks/loop-runtime-store.js";
import type { HookIo } from "../interfaces/hooks/protocol.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const HOOKS_LOG = path.join(RUNTIME, "logs", "hooks.log");
const HISTORY_LOG = path.join(RUNTIME, "logs", "history.log");
const CHANGES_LOG = path.join(RUNTIME, "logs", "changes.log");
const SESSION_LOG = path.join(RUNTIME, "logs", "session.md");
const READ_EVENTS = path.join(RUNTIME, "state", "readme-read-events.json");
const READM_GUARD_OK = path.join(RUNTIME, "logs", ".readme-guard-ok");
const BASELINE = path.join(RUNTIME, "state", "session-start-status.json");
const CURRENT_TASK = path.join(RUNTIME, "state", "current-task-id");
const PID_FILE = userClaudePidFile(RUNTIME);
const NOW = new Date("2026-08-21T12:00:00.000Z");

type SessionWorld = {
  ports: SessionHookPorts;
  io: HookIo;
  out: string[];
  store: Map<string, string>;
  env: Map<string, string>;
  checkpoint?: DispatchCheckpointView;
  summaryCalls: number;
  summaryExit: number;
  changed: string[];
  gitStatus: { code: number; stdout: string };
};

type SessionWorldInput = {
  stdin?: string;
  files?: Record<string, string>;
  env?: Record<string, string>;
  interactive?: boolean;
  alivePids?: number[];
  parentPid?: number;
};

function fakeSessionWorld(input: SessionWorldInput = {}): SessionWorld {
  const store = new Map(Object.entries(input.files ?? {}));
  const out: string[] = [];
  const alive = input.alivePids ?? [4242];
  const world: SessionWorld = {
    out,
    store,
    env: new Map(Object.entries(input.env ?? {})),
    summaryCalls: 0,
    summaryExit: 0,
    changed: [],
    gitStatus: { code: 0, stdout: "" },
    io: { out: (line) => out.push(line), error: (line) => out.push(line) },
    ports: {
      fs: {
        // Katalogo semantika: in-memory saugykloje katalogo įrašo nėra, tad jis „egzistuoja",
        // kai turi bent vieną vaiką (`.claude/specs` archyvavimo kelias to reikalauja).
        exists: async (p) => store.has(p) || [...store.keys()].some((key) => key.startsWith(`${p}${path.sep}`)),
        readTextFileIfExists: async (p) => store.get(p),
        writeTextFile: async (p, content) => void store.set(p, content),
        appendTextFile: async (p, text) => void store.set(p, `${store.get(p) ?? ""}${text}`),
        makeDirectory: async () => {},
        fileMtimeMs: async (p) => (store.has(p) ? NOW.getTime() : undefined),
        removeIfExists: async (p) => void store.delete(p),
        listMarkdownFiles: async (dir) =>
          [...store.keys()].filter((p) => p.startsWith(`${dir}${path.sep}`) && p.endsWith(".md")).sort(),
        renamePath: async (from, to) => {
          const value = store.get(from);
          if (value === undefined) throw new Error("ENOENT");
          store.delete(from);
          store.set(to, value);
        },
      },
      stdin: { readStdin: async () => input.stdin ?? "{}" },
      stdinIsInteractive: () => input.interactive === true,
      processIsAlive: (pid) => alive.includes(pid),
      parentPid: () => input.parentPid ?? 4242,
      env: (name) => world.env.get(name),
      gitStatusPorcelain: async () => world.gitStatus,
      readDispatchCheckpoint: async () => world.checkpoint,
      collectChangedFiles: async () => world.changed,
      runSessionSummary: async () => {
        world.summaryCalls += 1;
        return world.summaryExit;
      },
      now: () => NOW,
    },
  };
  return world;
}

function deps(world: SessionWorld): SessionHookDeps {
  return { ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME, io: world.io };
}

// ---------------------------------------------------------------------------
// runtime indikatorius
// ---------------------------------------------------------------------------

test("registerUserClaudeRuntime: dispatch sesija indikatoriaus NELIEČIA, neišspręstas PID nerašo", async () => {
  const dispatched = fakeSessionWorld({ env: { AG_DISPATCH_NONCE: "nonce-1" } });
  assert.equal(await registerUserClaudeRuntime(sessionHookContext(deps(dispatched))), false);
  assert.equal(dispatched.store.size, 0, "dispatch'inta sesija nėra vartotojo terminalas");

  // Sąžininga „nežinoma" būsena geriau nei įrašas, kuriuo negalima pasitikėti.
  const noPid = fakeSessionWorld({ parentPid: 1, alivePids: [1] });
  assert.equal(await registerUserClaudeRuntime(sessionHookContext(deps(noPid))), false);
  assert.equal(noPid.store.size, 0);

  const interactive = fakeSessionWorld();
  assert.equal(await registerUserClaudeRuntime(sessionHookContext(deps(interactive))), true);
  assert.equal(interactive.store.get(PID_FILE), "4242\n");
  assert.equal(JSON.parse(interactive.store.get(loopRuntimeRecordPath(PID_FILE)) ?? "null").pid, 4242);
});

test("releaseUserClaudeRuntime: dispatch sesija nevalo, o interaktyvi trina TIK savo įrašą", async () => {
  const record = JSON.stringify({ pid: 4242, started_at: NOW.toISOString(), heartbeat_at: NOW.toISOString() });

  const dispatched = fakeSessionWorld({
    env: { AG_DISPATCH_NONCE: "nonce-1" },
    files: { [loopRuntimeRecordPath(PID_FILE)]: record },
  });
  assert.equal(await releaseUserClaudeRuntime(sessionHookContext(deps(dispatched))), false);
  assert.equal(dispatched.store.has(loopRuntimeRecordPath(PID_FILE)), true, "svetimas įrašas lieka");

  const own = fakeSessionWorld({ files: { [loopRuntimeRecordPath(PID_FILE)]: record, [PID_FILE]: "4242\n" } });
  assert.equal(await releaseUserClaudeRuntime(sessionHookContext(deps(own))), true);
  assert.equal(own.store.size, 0);
});

// ---------------------------------------------------------------------------
// SessionStart vartai
// ---------------------------------------------------------------------------

test("isSessionContinuation: tik compact ir resume", () => {
  assert.equal(isSessionContinuation("compact"), true);
  assert.equal(isSessionContinuation("resume"), true);
  assert.equal(isSessionContinuation("startup"), false);
  assert.equal(isSessionContinuation("clear"), false);
});

test("hookSessionStart: continuation IŠLAIKO per-sesiją įrodymus", async () => {
  const world = fakeSessionWorld({
    stdin: JSON.stringify({ source: "compact" }),
    files: { [READ_EVENTS]: '["README.md"]', [CHANGES_LOG]: "src/a.ts\n" },
  });

  assert.equal(await hookSessionStart(deps(world)), 0);
  // Auto-compact vidury užduoties: nušluotas readme įrodymas uždarytų vartus grandinės
  // viduryje, o agentas jų atidaryti nebegali.
  assert.equal(world.store.get(READ_EVENTS), '["README.md"]');
  assert.equal(world.store.get(CHANGES_LOG), "src/a.ts\n");
  assert.match(world.store.get(HISTORY_LOG) ?? "", /SESSION_CONTINUE \(compact\)/);
});

test("hookSessionStart: tas pats dispatch bandymas (nonce) NEPERRAŠO baseline ir įrodymų", async () => {
  const world = fakeSessionWorld({
    stdin: JSON.stringify({ source: "startup" }),
    env: { AG_DISPATCH_NONCE: "nonce-1" },
    files: {
      [BASELINE]: JSON.stringify({ dispatch_nonce: "nonce-1", baseline_valid: true }),
      [READ_EVENTS]: '["README.md"]',
    },
  });
  world.gitStatus = { code: 0, stdout: " M src/a.ts\n" };

  assert.equal(await hookSessionStart(deps(world)), 0);
  // CLI restartas praneša `startup`, tad payload'o šaltinis nepatikimas — sprendžia tapatybė.
  assert.deepEqual(JSON.parse(world.store.get(BASELINE) ?? "null"), {
    dispatch_nonce: "nonce-1",
    baseline_valid: true,
  });
  assert.equal(world.store.get(READ_EVENTS), '["README.md"]');
  assert.match(world.store.get(HOOKS_LOG) ?? "", /tas pats dispatch bandymas/);
});

test("hookSessionStart: naujas dispatch bandymas užrašo baseline ir išvalo įrodymus", async () => {
  const world = fakeSessionWorld({
    stdin: JSON.stringify({ source: "startup" }),
    env: { AG_DISPATCH_NONCE: "nonce-2" },
    files: {
      [BASELINE]: JSON.stringify({ dispatch_nonce: "nonce-1", baseline_valid: true }),
      [READ_EVENTS]: '["README.md"]',
      [READM_GUARD_OK]: "ok",
      [CURRENT_TASK]: "890\n",
    },
  });
  world.gitStatus = { code: 0, stdout: " M src/a.ts\n" };

  assert.equal(await hookSessionStart(deps(world)), 0);
  const baseline = JSON.parse(world.store.get(BASELINE) ?? "null") as Record<string, unknown>;
  assert.equal(baseline["dispatch_nonce"], "nonce-2");
  assert.equal(baseline["task_id"], "890");
  assert.deepEqual(baseline["non_runtime_dirty_entries"], [{ status: " M", path: "src/a.ts" }]);
  assert.equal(world.store.has(READ_EVENTS), false, "naujas bandymas startuoja nuo švarios evidencijos");
  assert.equal(world.store.has(READM_GUARD_OK), false);
  assert.equal(world.store.get(CHANGES_LOG), "");
});

test("hookSessionStart: neveikiantis git palieka baseline NEGALIOJANTĮ, o ne tuščią", async () => {
  const world = fakeSessionWorld({ env: { AG_DISPATCH_NONCE: "nonce-1" } });
  world.gitStatus = { code: 128, stdout: "" };

  assert.equal(await hookSessionStart(deps(world)), 0);
  const baseline = JSON.parse(world.store.get(BASELINE) ?? "null") as Record<string, unknown>;
  // Tuščias purvo sąrašas su `baseline_valid: false` neleidžia clean-baseline rescue: nežinia
  // niekada neturi atrodyti kaip švarus medis.
  assert.equal(baseline["baseline_valid"], false);
  assert.deepEqual(baseline["non_runtime_dirty_entries"], [{ status: "!!", path: "<git status failed>" }]);
});

test("hookSessionStart: interaktyvi sesija NELIEČIA gyvo svetimo dispatch'o įrodymų", async () => {
  const world = fakeSessionWorld({
    stdin: JSON.stringify({ source: "startup" }),
    files: { [CURRENT_TASK]: "890\n", [READ_EVENTS]: '["README.md"]' },
  });
  world.checkpoint = {
    phase: "dispatch",
    status: "started",
    task_id: "890",
    updated_at: new Date(NOW.getTime() - 60_000).toISOString(),
  };

  assert.equal(await hookSessionStart(deps(world)), 0);
  assert.equal(world.store.get(READ_EVENTS), '["README.md"]');
  assert.match(world.store.get(HOOKS_LOG) ?? "", /gyvas dispatch bandymas/);

  // Pasibaigęs dispatch'as vartų nebelaiko: naujas terminalas startuoja švariai.
  const finished = fakeSessionWorld({
    stdin: JSON.stringify({ source: "startup" }),
    files: { [CURRENT_TASK]: "890\n", [READ_EVENTS]: '["README.md"]' },
  });
  finished.checkpoint = { ...world.checkpoint, status: "finished" };
  assert.equal(await hookSessionStart(deps(finished)), 0);
  assert.equal(finished.store.has(READ_EVENTS), false);
});

test("hookSessionStart: interaktyvus paleidimas (TTY) stdin NESKAITO ir elgiasi kaip startup", async () => {
  const world = fakeSessionWorld({ interactive: true, files: { [READ_EVENTS]: '["README.md"]' } });
  // Rankinis paleidimas hook payload'o neturi — stdin skaitymas kabintų procesą amžinai.
  world.ports.stdin.readStdin = () => Promise.reject(new Error("stdin nepasiekiamas"));

  assert.equal(await hookSessionStart(deps(world)), 0);
  assert.equal(world.store.has(READ_EVENTS), false);
  assert.match(world.store.get(SESSION_LOG) ?? "", /## Sesija/);
});

test("hookSessionStart: sesijos žurnalas numeruoja sesijas ir archyvuoja senus specs", async () => {
  const specsDir = path.join(ROOT, ".claude", "specs");
  const spec = path.join(specsDir, "plan.md");
  const world = fakeSessionWorld({
    files: {
      [SESSION_LOG]: "# Sesiju zurnalas\n\n## Sesija — sena\n",
      [HISTORY_LOG]: "[x] SESSION_END — pakeista failų: 3\n",
      [spec]: "# planas",
    },
  });

  assert.equal(await hookSessionStart(deps(world)), 0);
  const journal = world.store.get(SESSION_LOG) ?? "";
  assert.match(journal, /\*\*Sesijos nr\.:\*\* 2/);
  assert.match(journal, /\*\*Paskutine sesija:\*\* \[x\] SESSION_END/);
  assert.equal(world.store.has(spec), false, "gyvos grandinės specas archyvuojamas tik reset'o kelyje");
  assert.equal([...world.store.keys()].some((p) => p.includes("_archive")), true);
  assert.match(world.store.get(HISTORY_LOG) ?? "", /SESSION_START/);
});

// ---------------------------------------------------------------------------
// SessionEnd
// ---------------------------------------------------------------------------

test("hookSessionEnd: skaičiuojama iš nuotraukos, tad commit'inusi sesija nerodo 0", async () => {
  const world = fakeSessionWorld({
    files: { [path.join(RUNTIME, "logs", "session-changes.log")]: "src/a.ts\nsrc/b.ts\n" },
  });
  // `changes.log` jau išvalytas Stop hook'o po commit'o, o dabar nešvarus tik vienas failas.
  world.changed = ["src/c.ts"];

  assert.equal(await hookSessionEnd(deps(world)), 0);
  assert.match(world.store.get(HISTORY_LOG) ?? "", /SESSION_END — pakeista failų: 3/);
  assert.equal(world.summaryCalls, 1);
});

test("hookSessionEnd: nepavykusi santrauka pažymima, bet sesijos pabaigos nelaužo", async () => {
  const world = fakeSessionWorld();
  world.summaryExit = 2;

  assert.equal(await hookSessionEnd(deps(world)), 0);
  assert.match(world.store.get(HOOKS_LOG) ?? "", /session-summary nepavyko/);

  // Net metanti santraukos komanda negali pakeisti hook'o baigties.
  const throwing = fakeSessionWorld();
  throwing.ports.runSessionSummary = () => Promise.reject(new Error("CLI nerastas"));
  assert.equal(await hookSessionEnd(deps(throwing)), 0);
  assert.match(throwing.store.get(HOOKS_LOG) ?? "", /session-summary nepavyko/);
});
