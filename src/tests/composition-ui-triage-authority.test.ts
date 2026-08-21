// VQ-504 (59/N) testai — UI triage nuosavybės vartai.
//
// Iki 59/N verdiktas buvo fiksuotas `{ ok: true }`, tad UI galėjo pajudinti task'ą, kurį TUO METU
// laiko gyvas worker'is — jo darbo kopija ir lease liktų rodyti į failą, kurio ten nebėra. Testas
// prikala tikrą vartą: gyvas svetimas lease BLOKUOJA, o be lease'o triage praeina.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { uiRouterPorts } from "../composition/ui-router-adapters.js";
import { createWorkerLease, workerLeaseFile } from "../application/scheduling/worker-lease-store.js";
import { TaskAuthorityError } from "../interfaces/http/ui-task-actions.js";

async function workspace(): Promise<{ projectRoot: string; ports: ReturnType<typeof uiRouterPorts> }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-504-triage-"));
  const agRoot = path.join(projectRoot, "AG");
  const runtimeRoot = path.join(projectRoot, "vq");
  await mkdir(path.join(agRoot, "tasks", "human-review"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  await writeFile(path.join(agRoot, "tasks", "human-review", "0042.md"), "# 0042\n", "utf8");

  return { projectRoot, ports: uiRouterPorts({ projectRoot, runtimeRoot, agRoot, logError: () => {} }) };
}

/** Gyvas `held` lease šio proceso vardu — jo savininkas tikrai gyvas. */
async function placeLiveLease(projectRoot: string, taskId: string): Promise<void> {
  const lease = createWorkerLease(
    { owner_id: `loop-${process.pid}`, run_id: "r1", worker_id: "w2", task_id: taskId, attempt: 1 },
    { now: new Date(), fencingToken: 1, ttlMs: 60 * 60 * 1000 },
  );
  const file = workerLeaseFile(projectRoot, "w2");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(lease), "utf8");
}

test("be lease'o triage PRAEINA", async () => {
  const world = await workspace();
  try {
    const result = (await world.ports.applyTaskTriage("requeue", "0042")) as { task_id: string };
    assert.equal(result.task_id, "0042");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("GYVAS svetimas lease triage BLOKUOJA", async () => {
  const world = await workspace();
  try {
    await placeLiveLease(world.projectRoot, "0042");
    // Kitaip UI pajudintų task'ą, kurį tuo metu dirba worker'is, o jo lease liktų rodyti į failą,
    // kurio ten nebėra.
    await assert.rejects(() => world.ports.applyTaskTriage("requeue", "0042"), TaskAuthorityError);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("sugadintas lease irgi BLOKUOJA, o ne praleidžia", async () => {
  const world = await workspace();
  try {
    const file = workerLeaseFile(world.projectRoot, "w2");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ne json", "utf8");
    // Neperskaitytas store nėra „lease'o nėra": UI negali judinti to, kieno nuosavybės neįrodė.
    await assert.rejects(() => world.ports.applyTaskTriage("requeue", "0042"), TaskAuthorityError);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});
