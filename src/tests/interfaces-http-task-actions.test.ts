// VQ-503 (5/5-a) testai — įkėlimas į eilę ir triažo veiksmai. Svarbiausia, ką jie pin'ina:
// įkėlimas yra DARBO PALEIDIMAS, tad ribos galioja ir kiekiui, ir vienam failui, o VISI failai
// validuojami PRIEŠ rašymą; triaže leidžiamos tik dvi kryptys iš `human-review`, nuosavybės
// verdiktas paimamas PIRMAS (konfliktas nepalieka jokios mutacijos), o vardas visada imamas iš
// disko, ne iš užklausos raidžių lyties.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  InvalidUploadError,
  MAX_FILE_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  UploadTooLargeError,
  normalizeUploadPayload,
  sanitizeMarkdownFileName,
  uploadQueueMarkdownFiles,
  type TaskUploadPorts,
} from "../interfaces/http/task-upload.js";
import {
  InvalidTaskReferenceError,
  TaskAuthorityError,
  TaskBucketConflictError,
  TaskNotFoundError,
  applyTaskTriage,
  taskFileName,
  type TaskTriageDeps,
  type TaskTriagePorts,
} from "../interfaces/http/ui-task-actions.js";

const AG_ROOT = path.resolve("/repo/AG");
const QUEUE = path.join(AG_ROOT, "tasks", "queue");
const HUMAN_REVIEW = path.join(AG_ROOT, "tasks", "human-review");
const NOW = new Date("2026-08-21T12:00:00.000Z");

// ---------------------------------------------------------------------------
// įkėlimas
// ---------------------------------------------------------------------------

function uploadWorld(existing: string[] = []): { ports: TaskUploadPorts; store: Map<string, string> } {
  const store = new Map(existing.map((name) => [path.join(QUEUE, name), "senas"]));
  return {
    store,
    ports: {
      writeFileExclusive: (p, content) => {
        if (store.has(p)) return Promise.resolve("exists");
        store.set(p, content);
        return Promise.resolve("created");
      },
      makeDirectory: () => Promise.resolve(),
      now: () => NOW,
    },
  };
}

test("sanitizeMarkdownFileName: katalogai ir nesaugūs simboliai nustoja egzistuoti", () => {
  assert.equal(sanitizeMarkdownFileName("../../etc/passwd"), "passwd.md");
  assert.equal(sanitizeMarkdownFileName("C:/tmp/užduotis.md"), "u-duotis.md");
  assert.equal(sanitizeMarkdownFileName("plan"), "plan.md");
  // Kai iš kliento vardo nelieka nė vieno tinkamo simbolio, vardas gaminamas iš laikrodžio.
  assert.equal(sanitizeMarkdownFileName("///", NOW), `task-${NOW.getTime()}.md`);
});

test("normalizeUploadPayload: ribos galioja ir kiekiui, ir vienam failui", () => {
  assert.throws(() => normalizeUploadPayload("{ nebaigtas"), InvalidUploadError);
  assert.throws(() => normalizeUploadPayload(JSON.stringify({})), InvalidUploadError);
  assert.throws(() => normalizeUploadPayload(JSON.stringify({ files: [] })), InvalidUploadError);
  assert.throws(
    () => normalizeUploadPayload(JSON.stringify({ files: [{ name: "a.txt", content: "x" }] })),
    InvalidUploadError,
  );
  assert.throws(
    () => normalizeUploadPayload(JSON.stringify({ files: [{ name: "a.md", content: "   " }] })),
    InvalidUploadError,
  );

  // 5 MB kūno riba viena praleistų dešimtis tūkstančių mažų „užduočių", o kiekviena jų tampa
  // eilės įrašu, kurį loop'as vykdys.
  const many = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_unused, index) => ({
    name: `${index}.md`,
    content: "x",
  }));
  assert.throws(() => normalizeUploadPayload(JSON.stringify({ files: many })), UploadTooLargeError);

  const big = { name: "a.md", content: "x".repeat(MAX_FILE_BYTES + 1) };
  assert.throws(() => normalizeUploadPayload(JSON.stringify({ files: [big] })), UploadTooLargeError);

  // Bendra kūno riba (etalono 1:1): iki 2026-08-23 MAX_UPLOAD_BYTES buvo deklaruota, bet
  // nevykdoma — 5–8 MiB krovinys praeidavo pro vienintelę realią (serverio 8 MiB) ribą.
  const oversizedBody = `{"files":[]}${" ".repeat(MAX_UPLOAD_BYTES + 1)}`;
  assert.throws(() => normalizeUploadPayload(oversizedBody), UploadTooLargeError);
});

test("uploadQueueMarkdownFiles: kolizija gauna sufiksą, o dalinio įrašymo nėra", async () => {
  const world = uploadWorld(["plan.md"]);
  const saved = await uploadQueueMarkdownFiles(
    world.ports,
    AG_ROOT,
    JSON.stringify({ files: [{ name: "plan.md", content: "# naujas" }] }),
  );
  assert.deepEqual(saved, ["plan-2.md"]);
  assert.equal(world.store.get(path.join(QUEUE, "plan.md")), "senas", "esamas failas neperrašomas");

  // Vienas blogas failas atmeta VISĄ krovinį: dalinis įrašymas paliktų dalį eilėje, o klientas,
  // bandydamas iš naujo, pagamintų dublikatus.
  const partial = uploadWorld();
  await assert.rejects(
    () =>
      uploadQueueMarkdownFiles(
        partial.ports,
        AG_ROOT,
        JSON.stringify({ files: [{ name: "ok.md", content: "# ok" }, { name: "bad.txt", content: "x" }] }),
      ),
    InvalidUploadError,
  );
  assert.equal(partial.store.size, 0);
});

// ---------------------------------------------------------------------------
// triažas
// ---------------------------------------------------------------------------

type TriageWorld = {
  deps: TaskTriageDeps;
  files: Map<string, string[]>;
  moves: { from: string; toDir: string; name: string }[];
  ledgerCleared: string[];
  resets: string[];
  authority: { ok: boolean; reason?: string };
};

function triageWorld(files: Record<string, string[]> = {}): TriageWorld {
  const world: TriageWorld = {
    files: new Map(Object.entries(files)),
    moves: [],
    ledgerCleared: [],
    resets: [],
    authority: { ok: true },
    deps: undefined as unknown as TaskTriageDeps,
  };

  const ports: TaskTriagePorts = {
    listTaskFiles: (dir) => Promise.resolve(world.files.get(dir) ?? []),
    taskIdFromFile: (file) => path.basename(file).replace(/\.md$/i, ""),
    authorizeMutation: () => Promise.resolve(world.authority),
    clearLedgerEntry: (taskId) => {
      world.ledgerCleared.push(taskId);
      return Promise.resolve(true);
    },
    recordLlmCallReset: (taskId) => {
      world.resets.push(taskId);
      return Promise.resolve();
    },
    store: {
      moveTaskState: (from, toDir, name) => {
        world.moves.push({ from, toDir, name });
        return Promise.resolve(path.join(toDir, name));
      },
      finishTaskState: (_from, toDir, name) => Promise.resolve(path.join(toDir, name)),
      activateTaskFile: (taskFile) => Promise.resolve(taskFile),
    },
  };

  world.deps = { ports, agRoot: AG_ROOT };
  return world;
}

test("taskFileName: HTTP nuoroda su separatoriumi ar `..` ATMETAMA, ne apkarpoma", () => {
  assert.equal(taskFileName("0042"), "0042.md");
  assert.equal(taskFileName(" 0042.md "), "0042.md");
  assert.throws(() => taskFileName("../0042"), InvalidTaskReferenceError);
  assert.throws(() => taskFileName("queue/0042.md"), InvalidTaskReferenceError);
  assert.throws(() => taskFileName(""), InvalidTaskReferenceError);
  assert.throws(() => taskFileName(`${"x".repeat(201)}.md`), InvalidTaskReferenceError);
});

test("applyTaskTriage: requeue eina ledger → biudžetas → perkėlimas", async () => {
  const world = triageWorld({ [HUMAN_REVIEW]: ["0042.md"] });

  const result = await applyTaskTriage(world.deps, "requeue", "0042");
  assert.deepEqual(result, {
    action: "requeue",
    task: "0042.md",
    task_id: "0042",
    from: "human-review",
    to: "queue",
    ledger_cleared: true,
    llm_budget_reset: true,
  });
  assert.deepEqual(world.ledgerCleared, ["0042"]);
  assert.deepEqual(world.resets, ["0042"]);
  assert.equal(world.moves[0]?.toDir, QUEUE);
});

test("applyTaskTriage: complete NELIEČIA ledger'io ir biudžeto", async () => {
  const world = triageWorld({ [HUMAN_REVIEW]: ["0042.md"] });

  const result = await applyTaskTriage(world.deps, "complete", "0042.md");
  // Užvertimas neatšaukia istorijos apie tai, kas su task'u vyko.
  assert.deepEqual({ ledger: result.ledger_cleared, budget: result.llm_budget_reset, to: result.to }, {
    ledger: false,
    budget: false,
    to: "done",
  });
  assert.deepEqual(world.ledgerCleared, []);
  assert.deepEqual(world.resets, []);
});

test("applyTaskTriage: vardas imamas iš DISKO, ne iš užklausos raidžių lyties", async () => {
  const world = triageWorld({ [HUMAN_REVIEW]: ["Task-0042.MD"] });

  const result = await applyTaskTriage(world.deps, "complete", "task-0042.md");
  // Kitaip ledger'io raktas nesutaptų su tikruoju, o failas persivadintų perkėlimo metu.
  assert.equal(result.task, "Task-0042.MD");
  assert.equal(result.task_id, "Task-0042");
});

test("applyTaskTriage: svetimas bucket'as ir nesamas task'as atmetami skirtingai", async () => {
  const conflict = triageWorld({ [path.join(AG_ROOT, "tasks", "active")]: ["0042.md"] });
  await assert.rejects(() => applyTaskTriage(conflict.deps, "requeue", "0042"), TaskBucketConflictError);
  assert.deepEqual(conflict.moves, []);

  const missing = triageWorld();
  await assert.rejects(() => applyTaskTriage(missing.deps, "requeue", "0042"), TaskNotFoundError);
});

test("applyTaskTriage: nuosavybės verdiktas PIRMAS — konfliktas nepalieka jokios mutacijos", async () => {
  const world = triageWorld({ [HUMAN_REVIEW]: ["0042.md"] });
  world.authority = { ok: false, reason: "worker lease held" };

  await assert.rejects(() => applyTaskTriage(world.deps, "requeue", "0042"), TaskAuthorityError);
  // Be šio vartų pirmumo ledger'is jau būtų išvalytas, o biudžetas atstatytas.
  assert.deepEqual(world.ledgerCleared, []);
  assert.deepEqual(world.resets, []);
  assert.deepEqual(world.moves, []);
});

test("applyTaskTriage: kolizijos sufiksas grąžinamas FAKTINIU vardu", async () => {
  const world = triageWorld({ [HUMAN_REVIEW]: ["0042.md"] });
  world.deps.ports.store.moveTaskState = (_from, toDir) => Promise.resolve(path.join(toDir, "0042-2.md"));

  const result = await applyTaskTriage(world.deps, "requeue", "0042");
  // Prašytasis vardas tiksliniame bucket'e neegzistuotų — atsakymas nurodytų failą, kurio nėra.
  assert.equal(result.task, "0042-2.md");
});
