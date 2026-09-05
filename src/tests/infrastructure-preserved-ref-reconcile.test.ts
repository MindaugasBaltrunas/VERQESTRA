// 083-a-02: preserved-ref sutaikinimo testai. Pirma dalis — grynas `task=<id>` parse'as be
// jokio IO; antra — REALUS git laikinoje repozitorijoje, ta pati schema kaip
// infrastructure-preserved-ref-retention.test.ts.
//
// 197: sutaikomas ref'as gaminamas TIKRUOJU `restoreTaskScope` — vieninteliu
// `refs/verqestra/preserved/*` gamintoju. Iki tol testas žinutę su `task=` fabrikuodavo pats,
// tad nepastebėjo, kad gamintojas tos žymos nerašo ir kiekvienas našlaitis krenta į
// `task-id-not-found`. Fabrikuotas `commit-tree` liko tik ten, kur reikia žinutės, kurios
// gamintojas sukurti negali (be žymos, su sugadinta žyma).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { gitHead } from "../infrastructure/git/git-client.js";
import { PRESERVED_REF_PREFIX, restoreTaskScope } from "../infrastructure/git/rollback-scope.js";
import {
  parseTaskIdFromCommitMessage,
  reconcilePreservedRefs,
} from "../infrastructure/git/preserved-ref-reconcile.js";

test("parseTaskIdFromCommitMessage: atpazista task= zyma", () => {
  assert.equal(parseTaskIdFromCommitMessage("verqestra: preserved task scope task=083-a-02"), "083-a-02");
  assert.equal(parseTaskIdFromCommitMessage("task=083-a-02\n\nkiti dalykai"), "083-a-02");
});

test("parseTaskIdFromCommitMessage: be zymos -> undefined", () => {
  assert.equal(parseTaskIdFromCommitMessage("verqestra: preserved task scope"), undefined);
});

// --- Integracija: realus git + failų sistema laikinoje repozitorijoje ---

const root = await mkdtemp(path.join(tmpdir(), "vq-preserved-ref-reconcile-"));
const runtimeRoot = path.join(root, "vq");
const currentTaskIdPath = path.join(runtimeRoot, "state", "current-task-id");
after(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function git(...args: string[]): Promise<{ code: number; stdout: string }> {
  const result = await run("git", ["-C", root, ...args]);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

await git("init");
await git("config", "user.email", "test@example.com");
await git("config", "user.name", "Test");
await git("config", "commit.gpgsign", "false");
await git("config", "core.autocrlf", "false");
await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), "pradinis\n");
await git("add", "--all");
await git("commit", "-m", "pradinis");
const stable = await gitHead(root);
assert.ok(stable);

/**
 * Ref'as per TIKRĄ gamintoją: necommit'intas `src/a.ts` edit'as, po kurio `restoreTaskScope`
 * jį nufotografuoja į preserved commit'ą ir grąžina medį į `stable`. Kiekvienas kvietėjas
 * privalo duoti SKIRTINGĄ turinį — vienodas medis duotų tą patį commit'ą, tad ir tą patį ref'ą.
 */
async function preserveViaProducer(content: string, options: { taskId?: string } = {}): Promise<string> {
  await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), content);
  const restored = await restoreTaskScope(root, stable as string, ["src/a.ts"], options);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  if (!restored.ok) throw new Error("unreachable");
  assert.ok(restored.preserved, "gamintojas turejo sukurti preserved ref'a");
  return restored.preserved.ref;
}

/** Žinutė, kurios gamintojas sukurti negali — tik `unattributed` keliams. */
async function fabricatePreservedRef(content: string, message: string): Promise<string> {
  // git add SCOPED į src/a.ts: `--all` čia pagautų ir `vq/state/rollback-preserved/*.json`
  // (vq/ gyvena tame pačiame repo šaknyje) — vėlesnis `reset --hard` tada ištrintų juos kaip
  // naujai stage'intus, bet stable commit'e nesančius failus.
  await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), content);
  await git("add", "--", "src/a.ts");
  const treeResult = await git("write-tree");
  const tree = treeResult.stdout.trim();
  await git("reset", "--hard", stable as string);
  const commitTreeResult = await git("commit-tree", tree, "-p", stable as string, "-m", message);
  const commit = commitTreeResult.stdout.trim();
  const ref = `${PRESERVED_REF_PREFIX}${commit}`;
  await git("update-ref", ref, commit);
  return ref;
}

async function readCommitMessage(ref: string): Promise<string> {
  return (await git("log", "-1", "--format=%B", ref)).stdout.trim();
}

async function readRecord(taskId: string): Promise<Record<string, unknown> | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "state", "rollback-preserved", `${taskId}.json`));
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
}

async function reconcile(): Promise<{ result: Awaited<ReturnType<typeof reconcilePreservedRefs>>; logs: string[] }> {
  const logs: string[] = [];
  const result = await reconcilePreservedRefs(root, { agLog: async (line) => void logs.push(line) }, { runtimeRoot });
  return { result, logs };
}

test("gamintojas su taskId: zinute nesa task=, sutaikinimas atkuria .json", async () => {
  const ref = await preserveViaProducer("atkuriamas darbas\n", { taskId: "083-restored" });
  assert.equal(await readCommitMessage(ref), "verqestra: preserved task scope task=083-restored");

  const { result, logs } = await reconcile();

  const outcome = result.restored.find((entry) => entry.ref === ref);
  assert.ok(outcome, "turejo but restored");
  assert.equal(outcome?.status, "restored");
  if (outcome?.status !== "restored") return;
  assert.equal(outcome.taskId, "083-restored");

  const record = await readRecord("083-restored");
  assert.ok(record);
  assert.equal(record?.["ref"], ref);
  assert.equal(record?.["base_ref"], stable);
  assert.deepEqual(record?.["paths"], ["src/a.ts"]);
  assert.equal(typeof record?.["recorded_at"], "string");
  assert.ok(logs.some((line) => line.includes("PRESERVED REF RECONCILED") && line.includes(ref)));
});

test("gamintojas be taskId, bet su vq/state/current-task-id: zinute nesa task=", async () => {
  await nodeFsAdapter.writeTextFile(currentTaskIdPath, "083-fallback\n");
  try {
    const ref = await preserveViaProducer("tapatybe is current-task-id\n");
    assert.equal(await readCommitMessage(ref), "verqestra: preserved task scope task=083-fallback");

    const { result } = await reconcile();
    const outcome = result.restored.find((entry) => entry.ref === ref);
    assert.equal(outcome?.status, "restored");
    if (outcome?.status !== "restored") return;
    assert.equal(outcome.taskId, "083-fallback");
    assert.ok(await readRecord("083-fallback"));
  } finally {
    await nodeFsAdapter.removeFile(currentTaskIdPath);
  }
});

test("gamintojas be taskId ir be current-task-id: zinute be zymos -> task-id-not-found", async () => {
  assert.equal(await nodeFsAdapter.exists(currentTaskIdPath), false, "tapatybes saltinio cia but negali");
  const ref = await preserveViaProducer("be jokios tapatybes\n");
  assert.equal(await readCommitMessage(ref), "verqestra: preserved task scope");

  const { result, logs } = await reconcile();

  const outcome = result.unattributed.find((entry) => entry.ref === ref);
  assert.ok(outcome, "turejo but unattributed");
  assert.equal(outcome?.status, "unattributed");
  if (outcome?.status !== "unattributed") return;
  assert.equal(outcome.reason, "task-id-not-found");
  assert.ok(logs.some((line) => line.includes("PRESERVED REF UNATTRIBUTED") && line.includes(ref) && line.includes("candidate for retention")));
});

test("fabrikuota zinute be task= zymos -> unattributed, .json neparasomas", async () => {
  const ref = await fabricatePreservedRef("neatkuriamas darbas\n", "verqestra: preserved task scope");

  const { result, logs } = await reconcile();

  const outcome = result.unattributed.find((entry) => entry.ref === ref);
  assert.ok(outcome, "turejo but unattributed");
  assert.equal(outcome?.status, "unattributed");
  if (outcome?.status !== "unattributed") return;
  assert.equal(outcome.reason, "task-id-not-found");
  assert.ok(logs.some((line) => line.includes("PRESERVED REF UNATTRIBUTED") && line.includes(ref)));
});

test("fabrikuota zyma su keliu (task=../evil) -> task-id-invalid, nieko nerasoma", async () => {
  const ref = await fabricatePreservedRef("suklastota zyma\n", "verqestra: preserved task scope task=../evil");

  const { result } = await reconcile();

  const outcome = result.unattributed.find((entry) => entry.ref === ref);
  assert.ok(outcome, "turejo but unattributed");
  assert.equal(outcome?.status, "unattributed");
  if (outcome?.status !== "unattributed") return;
  assert.equal(outcome.reason, "task-id-invalid");
  assert.equal(await nodeFsAdapter.exists(path.join(runtimeRoot, "state", "rollback-preserved", "../evil.json")), false);
});

test("ref su egzistuojanciu irasu -> attributed, commit'as neskaitomas, irasas neperrasomas", async () => {
  const ref = await preserveViaProducer("jau irasytas darbas\n", { taskId: "083-existing" });
  const recordPath = path.join(runtimeRoot, "state", "rollback-preserved", "083-existing.json");
  const original = JSON.stringify(
    { task_id: "083-existing", ref, commit: "deadbeef", base_ref: "cafebabe", paths: ["custom.ts"], recorded_at: "2020-01-01T00:00:00.000Z" },
    null,
    2,
  );
  await nodeFsAdapter.writeTextFile(recordPath, original);

  const { result, logs } = await reconcile();

  const outcome = result.attributed.find((entry) => entry.ref === ref);
  assert.ok(outcome, "turejo but attributed");
  assert.equal(outcome?.status, "attributed");
  if (outcome?.status !== "attributed") return;
  assert.equal(outcome.taskId, "083-existing");
  assert.equal(await nodeFsAdapter.readTextFile(recordPath), original, "esamas irasas negali buti perrasytas");
  assert.equal(result.restored.some((entry) => entry.ref === ref), false);
  assert.equal(result.unattributed.some((entry) => entry.ref === ref), false);
  assert.equal(logs.some((line) => line.includes(ref)), false, "attributed ref'ui log'o neturi buti");
});

test("task id atkuriamas, bet taikinio .json jau uzimtas kito irasso -> unattributed, esamas failas neliestas", async () => {
  const recordPath = path.join(runtimeRoot, "state", "rollback-preserved", "083-collision.json");
  const original = JSON.stringify(
    { task_id: "083-collision", ref: "refs/verqestra/preserved/oldsha", commit: "oldsha", base_ref: stable, paths: ["old.ts"], recorded_at: "2020-01-01T00:00:00.000Z" },
    null,
    2,
  );
  await nodeFsAdapter.writeTextFile(recordPath, original);

  const ref = await preserveViaProducer("kolizija\n", { taskId: "083-collision" });

  const { result } = await reconcile();

  const outcome = result.unattributed.find((entry) => entry.ref === ref);
  assert.ok(outcome, "turejo but unattributed del kolizijos");
  assert.equal(outcome?.status, "unattributed");
  if (outcome?.status !== "unattributed") return;
  assert.ok(outcome.reason.startsWith("record-path-exists:"));
  assert.equal(await nodeFsAdapter.readTextFile(recordPath), original, "kito irasso negalima perrasyti");
});
