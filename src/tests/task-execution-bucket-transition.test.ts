// 092: perėjimai iš dispatch lango nuima `verificationPreamble` per vienintelį perėjimo
// tašką (`bucket-transition`). Invariantas: queue/done/human-review — visada kanoninė forma,
// dispatch'o forma leidžiama tik active/delegated bandymo lange. Atskiras failas nuo
// `task-execution-rules.test.ts` sąmoningai — tas jau prie 440 eil., o 500 eil. vartas
// baseline'o neturi.
import assert from "node:assert/strict";
import test from "node:test";
import {
  finishTaskInBucket,
  moveTaskToBucket,
  type TaskStateStorePort,
} from "../application/task-execution/bucket-transition.js";
import { verificationPreamble } from "../application/quality-gates/preflight-rules.js";

const PREAMBLE = verificationPreamble({ rebuild: "pnpm build", checks: ["pnpm build", "pnpm test"] });
const CANONICAL = "# Task\n\n## Tikslas\nX.\n";

type World = {
  store: TaskStateStorePort;
  writes: { path: string; text: string }[];
  moves: string[];
};

function world(content: string | undefined): World {
  const writes: { path: string; text: string }[] = [];
  const moves: string[] = [];
  let current = content;
  const store: TaskStateStorePort = {
    async moveTaskState(_from, toDir, taskName) {
      moves.push(`${toDir}/${taskName}`);
      return `${toDir}/${taskName}`;
    },
    async finishTaskState(_from, toDir, taskName) {
      moves.push(`${toDir}/${taskName}`);
      return `${toDir}/${taskName}`;
    },
    async activateTaskFile(_taskFile, activeFile) {
      return activeFile;
    },
    async readTaskText() {
      return current;
    },
    async writeTaskText(path_, text) {
      writes.push({ path: path_, text });
      current = text;
    },
  };
  return { store, writes, moves };
}

test("move active -> human-review nuima preambulę prieš perkėlimą", async () => {
  const w = world(`${PREAMBLE}${CANONICAL}`);
  await moveTaskToBucket(w.store, "/repo/AG", "/repo/AG/tasks/active/x.md", "human-review", "x.md");
  assert.equal(w.writes.length, 1, "nuimta preambulė įrašoma prieš move");
  assert.equal(w.writes[0]?.text, CANONICAL);
  assert.equal(w.moves.length, 1, "move įvyksta po strip");
});

test("move queue -> active turinio neliečia (dispatch langas — teisėta forma)", async () => {
  const w = world(`${PREAMBLE}${CANONICAL}`);
  await moveTaskToBucket(w.store, "/repo/AG", "/repo/AG/tasks/queue/x.md", "active", "x.md");
  assert.deepEqual(w.writes, [], "į langą įeinant strip netaikomas");
  await moveTaskToBucket(w.store, "/repo/AG", "/repo/AG/tasks/queue/x.md", "delegated", "x.md");
  assert.deepEqual(w.writes, [], "delegated — tas pats langas");
});

test("kanoninis turinys grįžta baitas-į-baitą be papildomo rašymo", async () => {
  const w = world(CANONICAL);
  await moveTaskToBucket(w.store, "/repo/AG", "/repo/AG/tasks/human-review/x.md", "queue", "x.md");
  assert.deepEqual(w.writes, [], "nepakitęs turinys neperrašomas");
  assert.equal(w.moves.length, 1);
});

test("finish -> done nuima preambulę; fence bloke cituojama antraštė lieka", async () => {
  const fenced = "# Task\n\n## Tikslas\nX.\n\n```\n## Žingsnis 0 — pavyzdys fence viduje\n```\n";
  const w = world(`${PREAMBLE}${fenced}`);
  await finishTaskInBucket(w.store, "/repo/AG", "/repo/AG/tasks/active/x.md", "done", "x.md", []);
  assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0]?.text, fenced, "strip fence-aware: cituojama antraštė nepaliesta");
});

test("trūkstamas šaltinio failas strip'o nekelia į klaidą — move'as praneša pats", async () => {
  const w = world(undefined);
  await moveTaskToBucket(w.store, "/repo/AG", "/repo/AG/tasks/human-review/x.md", "queue", "x.md");
  assert.deepEqual(w.writes, []);
  assert.equal(w.moves.length, 1, "sprendimą apie trūkstamą šaltinį priima store lock'o viduje");
});

// Task 124: preambulė iki šiol AKTYVIAI atgrasė nuo no-write bėgimų („parkuojamas human-review"
// be išimties), o AUDIT_COMPLETE neminėjo visai — „patikrinti X" task'ai, kurių sąžininga išvada
// „keisti nieko nereikia", sistemiškai parkavosi (072, 015-a-02, 015-b-03). Dispositions markerius
// priima tik eilutės pradžioje, tad instrukcija turi diktuoti būtent tą formą.
test("preambulė paaiškina abu no-write markerius ir įspėjimo išimtį", () => {
  assert.ok(PREAMBLE.includes("\nALREADY_IMPLEMENTED: "), "ALREADY_IMPLEMENTED — atskira eilute");
  assert.ok(PREAMBLE.includes("\nAUDIT_COMPLETE: "), "AUDIT_COMPLETE — atskira eilute");
  assert.match(
    PREAMBLE,
    /parkuojamas human-review — NEBENT [^\n]*ALREADY_IMPLEMENTED arba AUDIT_COMPLETE/,
    "human-review įspėjimas neša markerių išimtį — be jos vykdytojas atgrasomas nuo sąžiningo no-write",
  );
});
