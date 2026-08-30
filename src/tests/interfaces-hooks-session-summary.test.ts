// VQ-502 (6/6-e) testai — sesijos santrauka ir rollback apimties keliai. Svarbiausia, ką jie
// pin'ina: nepaleista patikra NIEKADA neatrodo žalia (NOT RUN / UNKNOWN), švaraus medžio atveju
// krentama į sesijos nuotrauką (kitaip commit'inusi sesija rodytų „None recorded"), o rollback
// atstato TIK šio dispatch'o nuosavus kelius.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { taskScopeRestorePaths } from "../application/task-execution/session-write-owners.js";
import {
  hookSessionSummary,
  type SessionSummaryDeps,
  type SessionSummaryPorts,
} from "../interfaces/hooks/session-summary.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const HOOKS_LOG = path.join(RUNTIME, "logs", "hooks.log");
const SUMMARY = path.join(RUNTIME, "logs", "session-summary.md");
const SNAPSHOT = path.join(RUNTIME, "logs", "session-changes.log");
const NOW = new Date("2026-08-21T12:00:00.000Z");

type SummaryWorld = {
  ports: SessionSummaryPorts;
  store: Map<string, string>;
  status: string;
  isRepo: boolean;
  changed: string[];
};

function summaryWorld(files: Record<string, string> = {}): SummaryWorld {
  const store = new Map(Object.entries(files));
  const world: SummaryWorld = {
    store,
    status: "",
    isRepo: true,
    changed: [],
    ports: {
      fs: {
        exists: async (p) => store.has(p),
        readTextFileIfExists: async (p) => store.get(p),
        writeTextFile: async (p, content) => void store.set(p, content),
        appendTextFile: async (p, text) => void store.set(p, `${store.get(p) ?? ""}${text}`),
        makeDirectory: async () => {},
        fileSizeBytes: async (p) => (store.has(p) ? (store.get(p) ?? "").length : undefined),
      },
      collectChangedFiles: async () => world.changed,
      isGitRepository: async () => world.isRepo,
      gitStatusText: async () => world.status,
      now: () => NOW,
    },
  };
  return world;
}

function deps(world: SummaryWorld): SessionSummaryDeps {
  return { ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME, io: { out: () => {}, error: () => {} } };
}

const summaryOf = (world: SummaryWorld): string => world.store.get(SUMMARY) ?? "";

test("hookSessionSummary: nepaleistos patikros lieka NOT RUN / UNKNOWN", async () => {
  const world = summaryWorld({ [HOOKS_LOG]: "[x] STOP įvykis\n" });

  assert.equal(await hookSessionSummary(deps(world)), 0);
  const summary = summaryOf(world);
  assert.match(summary, /- typecheck: NOT RUN \/ UNKNOWN/);
  assert.match(summary, /- tests: NOT RUN \/ UNKNOWN/);
  assert.match(summary, /- None recorded/);
  assert.match(world.store.get(HOOKS_LOG) ?? "", /session-summary parašyta/);
});

test("hookSessionSummary: laimi PASKUTINĖ žurnalo eilutė, o testų paleidimas nėra „praėjo\"", async () => {
  const world = summaryWorld({
    [HOOKS_LOG]: [
      "[1] TypeScript klaidų: 3",
      "[2] TypeScript OK — jokių klaidų",
      "[3] bash: pnpm test",
      "",
    ].join("\n"),
  });

  assert.equal(await hookSessionSummary(deps(world)), 0);
  const summary = summaryOf(world);
  // Žurnalas append-only: naujausias įrašas ir yra dabartinė būsena.
  assert.match(summary, /- typecheck: PASSED/);
  // Eilutė įrodo PALEIDIMĄ, ne rezultatą — ataskaita to skirtumo nenutrina.
  assert.match(summary, /- tests: RAN \/ CHECK LOGS/);
  assert.match(summary, /- pnpm test/);

  const failed = summaryWorld({ [HOOKS_LOG]: "[1] bash: pnpm test\n[2] bash: pnpm test failed\n" });
  await hookSessionSummary(deps(failed));
  assert.match(summaryOf(failed), /- tests: FAILED/);
});

test("hookSessionSummary: švarus medis krenta į sesijos nuotrauką, o ne į „None recorded\"", async () => {
  const world = summaryWorld({ [HOOKS_LOG]: "", [SNAPSHOT]: "src/a.ts\nsrc/b.ts\n" });

  assert.equal(await hookSessionSummary(deps(world)), 0);
  // Commit'inusiai sesijai Stop hook'as changes.log jau išvalė — be nuotraukos sucommit'inti
  // failai dingtų iš ataskaitos.
  assert.match(summaryOf(world), /- src\/a\.ts\n- src\/b\.ts/);

  const dirty = summaryWorld({ [HOOKS_LOG]: "" });
  dirty.status = " M src/c.ts";
  await hookSessionSummary(deps(dirty));
  assert.match(summaryOf(dirty), /- {2}M src\/c\.ts/);

  const noGit = summaryWorld({ [HOOKS_LOG]: "" });
  noGit.isRepo = false;
  await hookSessionSummary(deps(noGit));
  assert.match(summaryOf(noGit), /- Git repository unavailable/);
});

test("hookSessionSummary: blokados ir guard žurnalų dydžiai patenka į ataskaitą", async () => {
  const world = summaryWorld({
    [HOOKS_LOG]: "[1] STOP BLOKUOTAS — secret scan rado galimų slaptukų\n",
    [path.join(RUNTIME, "logs", "secret-scan.log")]: "12345",
  });

  assert.equal(await hookSessionSummary(deps(world)), 0);
  const summary = summaryOf(world);
  assert.match(summary, /## Blocked Actions\n- \[1\] STOP BLOKUOTAS/);
  assert.match(summary, /- secret-scan\.log \(5 bytes\)/);
});

test("taskScopeRestorePaths: atstatomi TIK šio dispatch'o nuosavi produkto keliai", () => {
  const owners = {
    "src/theirs.ts": { sessions: ["kitas-nonce"], tasks: ["999"] },
    "src/mine.ts": { sessions: ["nonce-1"], tasks: ["890"] },
  };

  // Runtime keliai niekada neatstatinėjami (jie yra loop'o buhalterija), o co-tenant'o rašymas
  // bendrame ledger'yje nebeprikrenta šiam task'ui — būtent tai etalone turinio lygiu
  // revertindavo svetimą darbą.
  assert.deepEqual(
    taskScopeRestorePaths(["src/mine.ts", "src/theirs.ts", "vq/state/x.json"], owners, {
      session: "nonce-1",
      taskId: "890",
    }),
    ["src/mine.ts"],
  );

  // Be nonce savininkystę sprendžia TIK sidecar'as: šio task'o įrašas atstatomas, svetimas —
  // ne. Anksčiau čia grįždavo abu keliai, tad rollback'as revertindavo lygiagrečios sesijos
  // necommit'intą darbą (auditas 2026-08-29, P1).
  assert.deepEqual(taskScopeRestorePaths(["src/mine.ts", "src/theirs.ts"], owners, { session: "", taskId: "890" }), [
    "src/mine.ts",
  ]);

  // To paties task'o kitas bandymas nėra svetimas.
  assert.deepEqual(
    taskScopeRestorePaths(["src/theirs.ts"], { "src/theirs.ts": { sessions: ["senas"], tasks: ["890"] } }, {
      session: "nonce-1",
      taskId: "890",
    }),
    ["src/theirs.ts"],
  );
});
