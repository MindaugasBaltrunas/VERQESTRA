// Task 040: `coordinatorStatePort(...).readClaudeLog` privalo skaityti SAVO bandymo žurnalą,
// ne bet kurios paskutinės sesijos globalų veidrodį. Fake TaskRunPorts (naudojami
// `task-execution-run.test.ts`) šio sujungimo netikrina — ten `readClaudeLog` faked
// task-id-nepriklausomai. Šie testai eina per REALŲ `coordinatorStatePort` adapterį ir
// realią attempt saugyklą (tas pats FS pagrindas kaip `task-execution-run.test.ts`
// 017-A-02 `routingAdapterInput` testas), o failas atskiras, nes `task-execution-run.test.ts`
// jau yra prie 500-eilučių vartų ribos (architecture-gates.test.ts, jokios baseline).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveNoCommitReviewReason } from "../domain/diagnosis/dispositions.js";
import { classifyDispatchWriteOutcome, extractDispatchToolUsage } from "../infrastructure/adapters/claude-tool-schema.js";
import { createAttempt, openAttempt } from "../infrastructure/persistence/runtime-artifact-store.js";
import { noRuntimeAttemptResolution, type AttemptResolutionPort } from "../infrastructure/state/attempt-resolution.js";
import type { AttemptRef } from "../application/scheduling/worker-limits.js";
import { coordinatorStatePort, type CoordinatorAdapterInput } from "../composition/loop/coordinator-adapters.js";
import { readClaudeSessionLog } from "../composition/quality/diagnose-adapters.js";

const TASK = "0042";

function attemptOnlyResolution(runtimeRoot: string, ref: AttemptRef): AttemptResolutionPort {
  return {
    async resolveActiveAttempt(taskId) {
      if (taskId !== ref.taskId) return { ok: false, reason: "no-runtime", errors: [] };
      const handle = await openAttempt(runtimeRoot, ref);
      if (!handle.ok) return { ok: false, reason: "not-created", errors: handle.errors };
      return { ok: true, attempt: { handle: handle.data, manifest: handle.data.manifest } };
    },
  };
}

function adapterInput(projectRoot: string, runtimeRoot: string, resolution: AttemptResolutionPort): CoordinatorAdapterInput {
  const unusedCli = (): never => {
    throw new Error("CLI portas šiame teste nekviečiamas");
  };
  return {
    projectRoot,
    runtimeRoot,
    agRoot: path.join(projectRoot, "AG"),
    resolution,
    runCli: unusedCli,
    runCliCaptured: unusedCli,
  };
}

const REF: AttemptRef = { runId: "r040", workerId: "w1", taskId: TASK, attemptId: "a1" };

async function withTaskAttempt(runtimeRoot: string): Promise<void> {
  const created = await createAttempt({
    runtimeRoot,
    ref: REF,
    graphHash: "none",
    policy: {},
    source: { origin: "queue-task" },
    createdAt: "2026-08-26T00:00:00.000Z",
  });
  assert.ok(created.ok);
}

test("coordinatorStatePort.readClaudeLog: attempt žurnalas be rašymo įrankių → tiksli priežastis (task 040)", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-040-attempt-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  try {
    await withTaskAttempt(runtimeRoot);
    const handle = await openAttempt(runtimeRoot, REF);
    assert.ok(handle.ok);
    await handle.data.appendLog("claude-last", '{"type":"system","subtype":"init","tools":["Read","Grep"]}');
    await handle.data.appendLog(
      "claude-last",
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"r1","name":"Read"}]}}',
    );

    // Globalus veidrodis SĄMONINGAI kitoks: jei adapteris jį vis dar skaitytų nepriklausomai
    // nuo taskId, šis testas tai pagautų — grąžintas tekstas rodytų "wrote", o ne "no-writes".
    await mkdir(path.join(runtimeRoot, "logs"), { recursive: true });
    await writeFile(
      path.join(runtimeRoot, "logs", "claude-last.log"),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"w1","name":"Write"}]}}',
      "utf8",
    );

    const state = coordinatorStatePort(adapterInput(projectRoot, runtimeRoot, attemptOnlyResolution(runtimeRoot, REF)));
    const activity = classifyDispatchWriteOutcome(extractDispatchToolUsage(await state.readClaudeLog(TASK)));
    assert.equal(activity, "no-writes");
    assert.equal(
      resolveNoCommitReviewReason({
        hasAlreadyImplementedMarker: false,
        productDirtyCount: 0,
        hasWorkEvidence: false,
        writeActivity: activity,
      }),
      "executor made no write-tool calls",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("coordinatorStatePort.readClaudeLog: attempt'o nėra → krenta į globalų veidrodį, 'unknown' priežasties nekeičia (task 040)", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-040-global-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  try {
    await mkdir(path.join(runtimeRoot, "logs"), { recursive: true });
    // Globalus žurnalas priklauso KITAM (jau baigtam) bandymui — jo turinys nėra šio task'o
    // stream'as, tad klasifikatorius teisingai grąžina "unknown", o ne "no-writes".
    await writeFile(path.join(runtimeRoot, "logs", "claude-last.log"), "svetimos sesijos stdout, ne JSONL\n", "utf8");

    const state = coordinatorStatePort(adapterInput(projectRoot, runtimeRoot, noRuntimeAttemptResolution));
    const claudeLog = await state.readClaudeLog(TASK);
    assert.equal(claudeLog, "svetimos sesijos stdout, ne JSONL\n");
    const activity = classifyDispatchWriteOutcome(extractDispatchToolUsage(claudeLog));
    assert.equal(activity, "unknown");
    assert.equal(
      resolveNoCommitReviewReason({
        hasAlreadyImplementedMarker: false,
        productDirtyCount: 0,
        hasWorkEvidence: false,
        writeActivity: activity,
      }),
      "clean tree without work evidence (deliverable missing — possibly rolled back)",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("coordinatorStatePort.readClaudeLog: attempt žurnalas su Write įrankiu → 'wrote', elgesys nepakitęs (task 040)", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-040-wrote-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  try {
    await withTaskAttempt(runtimeRoot);
    const handle = await openAttempt(runtimeRoot, REF);
    assert.ok(handle.ok);
    await handle.data.appendLog("claude-last", '{"type":"system","subtype":"init","tools":["Read","Write"]}');
    await handle.data.appendLog(
      "claude-last",
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"w1","name":"Write"}]}}',
    );

    const state = coordinatorStatePort(adapterInput(projectRoot, runtimeRoot, attemptOnlyResolution(runtimeRoot, REF)));
    const activity = classifyDispatchWriteOutcome(extractDispatchToolUsage(await state.readClaudeLog(TASK)));
    assert.equal(activity, "wrote");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// Task 090-B-03: dispatch'as nuo 090-A-02 turi attempt kanalo `claude-last` kelią, tad NAUJI
// bandymai rašo į savo katalogą. SENI bandymai to failo neturi — jie buvo paleisti, kai
// `resolveAttempt` grąžindavo stub'ą, ir jų žurnalas liko tik globaliame veidrodyje.
// Šis testas fiksuoja, kad įvielinimas tos grupės NESULAUŽĖ: attempt'as, kuris rezoliucijoje
// randamas, bet neturi savo `logs/claude-last.log`, toliau nukrenta į legacy veidrodį.
test("claude-last: IŠSPRĘSTAS attempt'as be savo žurnalo → legacy veidrodis, be lūžio (task 090-b-03)", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-090b03-legacy-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  const mirror = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"w1","name":"Write"}]}}';
  try {
    // Bandymas EGZISTUOJA (kitaip būtų tikrinama jau padengta `no-runtime` šaka), bet nė vienos
    // `appendLog("claude-last", …)` eilutės — tiksliai senų, dar neįvielintų bandymų forma.
    await withTaskAttempt(runtimeRoot);
    const resolution = attemptOnlyResolution(runtimeRoot, REF);
    await mkdir(path.join(runtimeRoot, "logs"), { recursive: true });
    await writeFile(path.join(runtimeRoot, "logs", "claude-last.log"), mirror, "utf8");

    // Kilmė tikrinama prie šaltinio: `readClaudeLog` grąžina vien tekstą, tad be šio tvirtinimo
    // testas praeitų ir tada, jei tas pats turinys ateitų per kokį nors kitą kanalą.
    const session = await readClaudeSessionLog(runtimeRoot, TASK, resolution);
    assert.equal(session.origin, "legacy");
    assert.equal(session.text, mirror);

    const state = coordinatorStatePort(adapterInput(projectRoot, runtimeRoot, resolution));
    const claudeLog = await state.readClaudeLog(TASK);
    assert.equal(claudeLog, mirror);
    assert.equal(classifyDispatchWriteOutcome(extractDispatchToolUsage(claudeLog)), "wrote");

    // Fallback'as yra matomas, ne tylus: operatorius turi atskirti savo bandymo žurnalą nuo
    // veidrodžio, kurį galėjo perrašyti lygiagretus worker'is.
    const orchestratorLog = await readFile(path.join(runtimeRoot, "logs", "orchestrator.log"), "utf8");
    assert.match(orchestratorLog, /WRITE ACTIVITY LOG FALLBACK: task=0042 origin=legacy/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// Task 041-a: REALUS adapteris atskiria tris `decision.json` baigtis — sugadintas turinys,
// SVETIMO task'o sprendimas (nuosavybės, ne turinio gedimas; rezultatas neša rastą task_id)
// ir savas tvarkingas sprendimas. Vartas nesikeičia: abu blogi keliai lieka `invalid`.
test("coordinatorStatePort.readDecision: corrupted / foreign / savas — trys skirtingos baigtys (task 041-a)", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-041a-decision-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  const decisionPath = path.join(runtimeRoot, "supervisor", "decision.json");
  try {
    await mkdir(path.dirname(decisionPath), { recursive: true });
    const state = coordinatorStatePort(adapterInput(projectRoot, runtimeRoot, noRuntimeAttemptResolution));

    await writeFile(decisionPath, "{ sugadintas", "utf8");
    assert.deepEqual(await state.readDecision(TASK), { status: "invalid", cause: "corrupted" });

    await writeFile(decisionPath, JSON.stringify({ task_id: "kitas-task", verdict: "delegate" }), "utf8");
    assert.deepEqual(await state.readDecision(TASK), {
      status: "invalid",
      cause: "foreign",
      decisionTaskId: "kitas-task",
    });

    await writeFile(decisionPath, JSON.stringify({ task_id: TASK, verdict: "delegate" }), "utf8");
    const own = await state.readDecision(TASK);
    assert.equal(own.status, "ok");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
