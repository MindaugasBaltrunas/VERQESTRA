// Task 043: perėjimų piltuvas (`coordinatorJournalPort.recordEvent`) turi maitinti learning
// atmintį ir token analitikos snapshot'ą, ne tik `logs/task-events.jsonl`. Iki šio surišimo
// `emitLearningEventsForTaskTransition` ir `updateTokenAnalyticsSnapshot` turėjo tik testų
// kvietėjus — `vq/state/learning/events.jsonl` niekada realiai nesipildydavo. Testai eina per
// REALŲ `coordinatorJournalPort` (ne tiesioginį emiterio kvietimą), nes būtent surišimo trūkumo
// tiesioginiai emiterio unit testai negalėjo pagauti — jie tikrino funkciją, o ne jos kvietėją.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { coordinatorJournalPort, type CoordinatorAdapterInput } from "../composition/loop/coordinator-adapters.js";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";

function adapterInput(projectRoot: string, runtimeRoot: string): CoordinatorAdapterInput {
  const unusedCli = (): never => {
    throw new Error("CLI portas šiame teste nekviečiamas");
  };
  return {
    projectRoot,
    runtimeRoot,
    agRoot: path.join(projectRoot, "AG"),
    resolution: noRuntimeAttemptResolution,
    runCli: unusedCli,
    runCliCaptured: unusedCli,
  };
}

async function withTempRuntime(run: (runtimeRoot: string) => Promise<void>): Promise<void> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-043-learning-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  try {
    await run(runtimeRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

async function readJsonLines(filePath: string): Promise<unknown[]> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

async function pathExists(target: string): Promise<boolean> {
  return await readFile(target)
    .then(() => true)
    .catch(() => false);
}

test("coordinatorJournalPort.recordEvent: terminalinis perėjimas palieka task_outcome įrašą ir atnaujina token analitikos snapshot'ą (task 043)", async () => {
  await withTempRuntime(async (runtimeRoot) => {
    const journal = coordinatorJournalPort(adapterInput(path.dirname(runtimeRoot), runtimeRoot));

    await journal.recordEvent({ task_id: "0100", to_state: "done", reason: "ok" });

    const eventLines = await readJsonLines(path.join(runtimeRoot, "logs", "task-events.jsonl"));
    assert.equal(eventLines.length, 1);
    assert.deepEqual((eventLines[0] as { task_id: string; to_state: string }).task_id, "0100");

    const learningLines = await readJsonLines(path.join(runtimeRoot, "state", "learning", "events.jsonl"));
    const taskOutcomes = learningLines.filter(
      (record) => (record as { type: string }).type === "task_outcome",
    ) as Array<{ task_id: string; summary: string }>;
    assert.equal(taskOutcomes.length, 1);
    assert.equal(taskOutcomes[0]?.task_id, "0100");
    assert.match(taskOutcomes[0]?.summary ?? "", /^done: ok$/);

    const snapshotRaw = await readFile(path.join(runtimeRoot, "state", "token-analytics", "snapshot.json"), "utf8");
    const snapshot = JSON.parse(snapshotRaw) as { totals: { records: number } };
    assert.ok(snapshot.totals);
  });
});

test("coordinatorJournalPort.recordEvent: queue/active perėjimas nerašo learning įrašų nei snapshot'o (task 043)", async () => {
  await withTempRuntime(async (runtimeRoot) => {
    const journal = coordinatorJournalPort(adapterInput(path.dirname(runtimeRoot), runtimeRoot));

    await journal.recordEvent({ task_id: "0101", to_state: "active", reason: "dispatch" });
    await journal.recordEvent({ task_id: "0101", to_state: "queue", reason: "requeue" });

    const eventLines = await readJsonLines(path.join(runtimeRoot, "logs", "task-events.jsonl"));
    assert.equal(eventLines.length, 2);

    assert.equal(await pathExists(path.join(runtimeRoot, "state", "learning", "events.jsonl")), false);
    assert.equal(await pathExists(path.join(runtimeRoot, "state", "token-analytics", "snapshot.json")), false);
  });
});

test("coordinatorJournalPort.recordEvent: learning fs klaida praryjama, jsonl eilutė vis tiek įrašyta (task 043)", async () => {
  await withTempRuntime(async (runtimeRoot) => {
    // `state/learning` egzistuoja kaip FAILAS, ne katalogas — `appendLearningMemoryRecord`
    // vidinis `makeDirectory` kris ant jo. Emiteris ir surišimas turi praryti šią klaidą.
    await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
    await writeFile(path.join(runtimeRoot, "state", "learning"), "not a directory", "utf8");

    const journal = coordinatorJournalPort(adapterInput(path.dirname(runtimeRoot), runtimeRoot));

    await assert.doesNotReject(journal.recordEvent({ task_id: "0102", to_state: "done", reason: "ok" }));

    const eventLines = await readJsonLines(path.join(runtimeRoot, "logs", "task-events.jsonl"));
    assert.equal(eventLines.length, 1);
    assert.equal((eventLines[0] as { to_state: string }).to_state, "done");
  });
});
