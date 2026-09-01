// VQ-304 (2 dalis): kanoninio RunCoordinator sekos testai su fake TaskRunPorts — start/resume
// keliai, terminaliniai perėjimai (duplicate/human-review/done/rollback), infrastruktūros
// abort'o preserve-vs-requeue, preflight retry guard memo, cheap finish ratas ir integracijos
// vartų advisory trumpinys. Jokios realios FS/git/CLI.
import assert from "node:assert/strict";
import test from "node:test";
import { createRunCoordinator } from "../application/task-execution/run-coordinator.js";
import type { CheapFinishPort, PreflightFailureMemoPort } from "../application/task-execution/run-coordinator-ports.js";
import type { PreservedWorkReviewPorts } from "../application/task-execution/preserved-work-review-model.js";
import {
  PREFLIGHT_FAILURE_MEMO_SCHEMA_VERSION,
  type PreflightFailureMemoRecord,
} from "../application/quality-gates/preflight-memo-schema.js";
import { createFakeTaskRunEnv, fakeBucketPath, type FakeTaskRunEnv } from "./helpers/fake-task-run-ports.js";

const TASK = "0042";
const TASK_MD = `${TASK}.md`;

function seedQueue(env: FakeTaskRunEnv, body = "# Task\n## Tikslas\nX"): string {
  const queuedFile = fakeBucketPath("queue", TASK_MD);
  env.files.set(queuedFile, body);
  return queuedFile;
}

function makePreflightMemo(): { port: PreflightFailureMemoPort; store: Map<string, PreflightFailureMemoRecord> } {
  const store = new Map<string, PreflightFailureMemoRecord>();
  return {
    store,
    port: {
      read: async (taskId) => {
        const record = store.get(taskId);
        return record ? { status: "hit", record } : { status: "absent" };
      },
      record: async (record) => void store.set(record.task_id, record),
      clear: async (taskId) => void store.delete(taskId),
    },
  };
}

test("start: duplicate fingerprint parkuojamas į human-review ir NEskelbiamas sėkme", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env);
  env.ports.ledger.seenBefore = async () => true;
  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.start(queuedFile);
  assert.equal(result, false, "duplicate niekada negrąžina true — dependents lieka užblokuoti");
  assert.ok(env.files.has(fakeBucketPath("human-review", TASK_MD)), "failas parkuotas human-review");
  assert.equal(env.journalEvents.at(-1)?.to_state, "duplicate");
  assert.equal(env.cliCalls.length, 0, "nei preflight, nei dispatch nevyko");
});

test("start: pilnas kelias queue→preflight→delegate→dispatch→verify→done", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env);
  env.behavior.decision = { status: "ok", decision: { verdict: "delegate" } };
  env.behavior.cli = (args) => {
    if (args[0] === "claude-diagnose") {
      env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
      env.behavior.git.hasNewHeadSince = true;
      env.behavior.git.changedProductPaths = ["src/x.txt"];
    }
    return 0;
  };
  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.start(queuedFile);
  assert.equal(result, true);
  assert.ok(env.files.has(fakeBucketPath("done", TASK_MD)), "failas terminaliniame done bucket'e");
  const commands = env.cliCalls.map((args) => args[0]);
  assert.deepEqual(
    commands,
    ["claude-preflight", "claude-dispatch", "quality-gates", "claude-diagnose"],
    "CLI kvietimų seka yra elgesio kontraktas",
  );
  assert.equal(env.journalEvents.at(-1)?.reason, "done");
  assert.ok(env.logs.some((line) => line === `TASK DONE: ${TASK}`));
});

test("start: done kelias išvalo current-task-file žymę per compare-and-clear portą (126)", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env);
  const clearCalls: string[] = [];
  env.ports.tasks.clearCurrentTaskFile = async (expected) => {
    clearCalls.push(expected);
    return true;
  };
  env.behavior.decision = { status: "ok", decision: { verdict: "delegate" } };
  env.behavior.cli = (args) => {
    if (args[0] === "claude-diagnose") {
      env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
      env.behavior.git.hasNewHeadSince = true;
      env.behavior.git.changedProductPaths = ["src/x.txt"];
    }
    return 0;
  };
  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.start(queuedFile);
  assert.equal(result, true);
  assert.deepEqual(clearCalls, [fakeBucketPath("done", TASK_MD)], "valoma su TERMINALINIU (done) keliu");
});

test("start: current-task-file valymo klaida virsta WARNING log'u, perėjimas lieka sėkmingas (126)", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env);
  env.ports.tasks.clearCurrentTaskFile = async () => {
    throw new Error("marker io error");
  };
  env.behavior.decision = { status: "ok", decision: { verdict: "delegate" } };
  env.behavior.cli = (args) => {
    if (args[0] === "claude-diagnose") {
      env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
      env.behavior.git.hasNewHeadSince = true;
      env.behavior.git.changedProductPaths = ["src/x.txt"];
    }
    return 0;
  };
  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.start(queuedFile);
  assert.equal(result, true, "valymo klaida nesulaužo terminalinio perėjimo");
  assert.ok(env.files.has(fakeBucketPath("done", TASK_MD)));
  assert.ok(
    env.logs.some((line) => line.includes(`WARNING: current-task-file clear failed task=${TASK}`) && line.includes("marker io error")),
  );
});

test("start: duplicate fingerprint taip pat išvalo current-task-file žymę (126)", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env);
  const clearCalls: string[] = [];
  env.ports.tasks.clearCurrentTaskFile = async (expected) => {
    clearCalls.push(expected);
    return true;
  };
  env.ports.ledger.seenBefore = async () => true;
  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.start(queuedFile);
  assert.equal(result, false);
  assert.deepEqual(clearCalls, [fakeBucketPath("human-review", TASK_MD)]);
});

test("start: work-evidence skip uždaro kaip done-already-implemented be jokios LLM sesijos", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env);
  env.behavior.git.committedProductWorkSha = "abc123";
  env.behavior.git.productDirtyCount = 0;
  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.start(queuedFile);
  assert.equal(result, true);
  assert.deepEqual(env.cliCalls.map((args) => args[0]), ["quality-gates"], "tik patikros, jokio dispatch/preflight");
  assert.ok(env.logs.some((line) => line.includes(`TASK DONE (ALREADY_IMPLEMENTED): ${TASK} via=skip-dispatch`)));
  assert.ok(env.files.has(fakeBucketPath("done", TASK_MD)));
});

test("start: raudonas preflight rašo memo, o antras bandymas be pakeitimo parkuojamas BE preflight", async () => {
  const env = createFakeTaskRunEnv();
  const memo = makePreflightMemo();
  env.ports.preflightMemo = memo.port;
  env.behavior.cli = (args) => (args[0] === "claude-preflight" ? { code: 3, output: "bad section" } : 0);

  const coordinator = createRunCoordinator(env.ports);
  const first = await coordinator.start(seedQueue(env));
  assert.equal(first, false);
  assert.equal(memo.store.get(TASK)?.repeat_count, 1, "memo užrašytas po realaus kritimo");
  assert.equal(memo.store.get(TASK)?.exit_code, 3);

  // Tas pats turinys grįžta į eilę (requeue) — guard'as parkuoja dar PRIEŠ preflight kvietimą.
  env.files.delete(fakeBucketPath("human-review", TASK_MD));
  const before = env.cliCalls.length;
  const second = await coordinator.start(seedQueue(env));
  assert.equal(second, false);
  assert.equal(env.cliCalls.length, before, "antrame rate preflight CLI nekviestas");
  assert.equal(memo.store.get(TASK)?.repeat_count, 2, "hit'as didina repeat, failed_at nekeičiamas");
  assert.ok(env.logs.some((line) => line.includes("TASK PREFLIGHT RETRY GUARD")));
});

test("start: pasenęs (25h) preflight memo ištrinamas skaitymo metu ir task eina įprastu keliu iki done", async () => {
  const env = createFakeTaskRunEnv();
  const memo = makePreflightMemo();
  env.ports.preflightMemo = memo.port;
  const oldFailedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  memo.store.set(TASK, {
    schema_version: PREFLIGHT_FAILURE_MEMO_SCHEMA_VERSION,
    task_id: TASK,
    content_hash: "stale-hash",
    failure_class: "preflight-exit",
    exit_code: 3,
    failed_at: oldFailedAt,
    repeat_count: 4,
  });
  env.behavior.decision = { status: "ok", decision: { verdict: "delegate" } };
  env.behavior.cli = (args) => {
    if (args[0] === "claude-diagnose") {
      env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
      env.behavior.git.hasNewHeadSince = true;
      env.behavior.git.changedProductPaths = ["src/x.txt"];
    }
    return 0;
  };

  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.start(seedQueue(env));

  assert.equal(result, true, "pasenęs memo neparkuoja — task užbaigia normalų kelią");
  assert.equal(memo.store.has(TASK), false, "pasenęs įrašas ištrintas iš store lazy skaitymo metu");
  assert.ok(env.logs.some((line) => line === `PREFLIGHT MEMO EXPIRED: task=${TASK} age=25h`));
  assert.ok(
    !env.journalEvents.some((event) => event.phase === "preflight-retry-guard"),
    "jokio guard human-review žurnalo įrašo",
  );
  assert.ok(env.cliCalls.some((args) => args[0] === "claude-preflight"), "guard'as nebeblokuoja preflight kvietimo");
  assert.ok(env.files.has(fakeBucketPath("done", TASK_MD)));
});

test("start: dispatch infrastruktūros gedimas meta abort'ą ir grąžina task'ą į queue", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env);
  env.behavior.decision = { status: "ok", decision: { verdict: "delegate" } };
  env.behavior.cli = (args) => (args[0] === "claude-dispatch" ? 77 : 0);
  env.behavior.dispatchInfrastructureFailure = true;
  const coordinator = createRunCoordinator(env.ports);
  await assert.rejects(
    () => coordinator.start(queuedFile),
    (error: Error & { taskReturnedToQueue?: boolean }) => {
      assert.match(error.message, /dispatch infrastructure failure exit=77/);
      assert.equal(error.taskReturnedToQueue, true);
      return true;
    },
  );
  assert.ok(env.files.has(fakeBucketPath("queue", TASK_MD)), "failas grąžintas į queue");
  assert.ok(env.logs.some((line) => line.includes("LOOP ABORT (infrastruktura)") && line.includes("returned_to_queue")));
});

test("resume(error): repair būsena su prompt'u IŠSAUGOMA infra abort'o metu (preserve)", async () => {
  const env = createFakeTaskRunEnv();
  const errorFile = fakeBucketPath("error", TASK_MD);
  env.files.set(errorFile, "# Task\noriginalas");
  env.behavior.repairPrompt = "# Repair Task\nfix X";
  env.behavior.cli = (args) => (args[0] === "claude-dispatch" ? 77 : 0);
  env.behavior.dispatchInfrastructureFailure = true;
  const coordinator = createRunCoordinator(env.ports);
  await assert.rejects(
    () => coordinator.resume("error", errorFile),
    (error: Error & { taskPreservedForResume?: boolean; taskReturnedToQueue?: boolean }) => {
      assert.equal(error.taskPreservedForResume, true);
      assert.equal(error.taskReturnedToQueue, false);
      return true;
    },
  );
  assert.ok(env.files.has(errorFile), "failas liko error bucket'e resume tęsimui");
  assert.ok(env.logs.some((line) => line.includes("repair_preserved_in=error")));
});

test("verifikacijos ciklas: repair → redispatch → antras ratas → done", async () => {
  const env = createFakeTaskRunEnv();
  const activeFile = fakeBucketPath("active", TASK_MD);
  env.files.set(activeFile, "# Task\nX");
  env.ports.state.readResumeState = async () => ({
    status: "ok",
    value: { task_id: TASK, phase: "verify", status: "started" },
  });
  env.behavior.repairPrompt = "# Repair Task\nfix";
  env.behavior.decision = { status: "ok", decision: { verdict: "repair" } };
  let diagnoseCalls = 0;
  env.behavior.cli = (args) => {
    if (args[0] === "claude-diagnose") {
      diagnoseCalls += 1;
      if (diagnoseCalls >= 2) {
        env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
        env.behavior.git.hasNewHeadSince = true;
        env.behavior.git.changedProductPaths = ["src/x.txt"];
      }
    }
    return 0;
  };
  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.resume("active", activeFile);
  assert.equal(result, true);
  assert.equal(diagnoseCalls, 2, "repair redispatch suka antrą verifikacijos ratą");
  assert.ok(env.cliCalls.some((args) => args[0] === "retry-guard"));
  assert.ok(env.files.has(fakeBucketPath("done", TASK_MD)));
});

test("verifikacijos ciklas: rollback_stop verdiktas — rollback + parkas su fazine diagnosis eilute", async () => {
  const env = createFakeTaskRunEnv();
  const activeFile = fakeBucketPath("active", TASK_MD);
  env.files.set(activeFile, "# Task\nX");
  env.ports.state.readResumeState = async () => ({
    status: "ok",
    value: { task_id: TASK, phase: "verify", status: "started" },
  });
  env.behavior.decision = { status: "ok", decision: { verdict: "rollback_stop", reason: "scope violated" } };
  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.resume("active", activeFile);
  assert.equal(result, false);
  assert.ok(env.cliCalls.some((args) => args[0] === "rollback-stable"));
  assert.ok(env.journalEvents.some((event) => event.phase === "diagnosis" && event.reason === "scope violated"));
  assert.ok(env.files.has(fakeBucketPath("human-review", TASK_MD)));
});

test("cheap finish: pre-repair paruošimas + dispatch'as, o pakartotinis repair — cheap_finish_failed parkas be rollback", async () => {
  const env = createFakeTaskRunEnv();
  const activeFile = fakeBucketPath("active", TASK_MD);
  env.files.set(activeFile, "# Task\n## Tikslas\nX");
  env.ports.state.readResumeState = async () => ({
    status: "ok",
    value: { task_id: TASK, phase: "verify", status: "started" },
  });
  env.behavior.decision = {
    status: "ok",
    decision: { verdict: "repair", reason: "local-diagnosis: clear local issue: error TS2322 src/x.ts" },
  };
  env.behavior.git.productDirtyCount = 1;
  const armed: unknown[] = [];
  const cheapFinish: CheapFinishPort = {
    read: async () => ({ status: "absent" }),
    arm: async (record) => void armed.push(record),
    retryBudget: async () => ({ count: 2, max: 3, nextWouldReachLimit: true }),
    prepareDispatch: async () => ({ ok: true, attemptSequence: 3, selectedModel: "sonnet", errors: [] }),
  };
  env.ports.cheapFinish = cheapFinish;
  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.resume("active", activeFile);
  assert.equal(result, false, "antras repair verdiktas po cheap finish parkuoja");
  assert.equal(armed.length, 1, "žymė užrašyta lygiai kartą");
  assert.ok(env.logs.some((line) => line.includes("REPAIR CHEAP-FINISH:") && line.includes("blocked_by=retry-limit")));
  assert.ok(env.logs.some((line) => line.includes("cheap_finish_failed=1")));
  assert.ok(!env.cliCalls.some((args) => args[0] === "rollback-stable"), "dalinis darbas nesunaikinamas");
  assert.ok(!env.cliCalls.some((args) => args[0] === "retry-guard"), "cheap finish aplenkia repair ratą pre-repair taške");
  assert.ok(env.files.has(fakeBucketPath("human-review", TASK_MD)));
});

// --- 063-c-04: preservedWorkReview portas prakišamas per createRunCoordinator opcijas -------

const PRESERVED_REF = "refs/verqestra/preserved/deadbeef";
const PRESERVED_TASK_BODY = `# Task

## Failai
Leidžiama:
- \`src/x.ts\`

## Patikra
- \`pnpm typecheck\`
`;

/**
 * `done` verdiktas be naujo commit'o + purvinas medis → rollback preserved'ina darbą ir
 * išspausdina `ROLLBACK PRESERVED: … ref=<ref>`. Būtent ant šios eilutės verify kelias
 * kviečia preserved-work review, jei portas iki jo atkeliavo.
 */
function preservedRollbackEnv(): { env: FakeTaskRunEnv; activeFile: string } {
  const env = createFakeTaskRunEnv();
  const activeFile = fakeBucketPath("active", TASK_MD);
  env.files.set(activeFile, PRESERVED_TASK_BODY);
  env.ports.state.readResumeState = async () => ({
    status: "ok",
    value: { task_id: TASK, phase: "verify", status: "started" },
  });
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
  env.behavior.git.productDirtyCount = 1;
  env.behavior.git.committedProductWorkSha = undefined;
  env.behavior.cli = (args) =>
    args[0] === "rollback-stable"
      ? {
          code: 0,
          output: `ROLLBACK PRESERVED: task=${TASK} ref=${PRESERVED_REF} commit=deadbeef paths=1 record=/vq/state/rollback-preserved/${TASK}.json`,
        }
      : 0;
  return { env, activeFile };
}

test("preservedWorkReview: coordinator opcija pasiekia verify kelią ir žalias verdiktas uždaro done", async () => {
  const { env, activeFile } = preservedRollbackEnv();
  const checked: Array<[string, string]> = [];
  const preservedWorkReview: PreservedWorkReviewPorts = {
    materialize: async (ref) => {
      assert.equal(ref, PRESERVED_REF, "portas gauna būtent rollback'o paskelbtą ref'ą");
      return {
        ok: true,
        work: { worktreePath: "/worktrees/preserved/deadbeef", changedPaths: ["src/x.ts"], dispose: async () => {} },
      };
    },
    runCheck: async (worktreePath, command) => {
      checked.push([worktreePath, command]);
      return { exitCode: 0, output: "ok" };
    },
  };

  const coordinator = createRunCoordinator(env.ports, { preservedWorkReview });
  const result = await coordinator.resume("active", activeFile);

  assert.equal(result, true, "atkurtas preserved darbas uždaro task'ą, o ne parkuoja");
  assert.deepEqual(checked, [["/worktrees/preserved/deadbeef", "pnpm typecheck"]], "`## Patikra` paleista worktree'je");
  assert.ok(env.files.has(fakeBucketPath("done", TASK_MD)), "failas terminaliniame done bucket'e");
  assert.ok(!env.files.has(fakeBucketPath("human-review", TASK_MD)));
});

test("preservedWorkReview: be porto — tas pats bėgimas parkuojamas kaip iki 063 (backward compat)", async () => {
  const { env, activeFile } = preservedRollbackEnv();

  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.resume("active", activeFile);

  assert.equal(result, false);
  assert.ok(env.files.has(fakeBucketPath("human-review", TASK_MD)));
  assert.ok(
    env.logs.some((line) => line.includes(`preserved_work=${PRESERVED_REF}`)),
    "priežastis lieka nepakitusi preserved_work eilutė",
  );
});

test("integracijos vartai: advisory režimas užregistruoja verdiktą ir praleidžia done", async () => {
  const env = createFakeTaskRunEnv();
  const activeFile = fakeBucketPath("active", TASK_MD);
  env.files.set(activeFile, "# Task\nX");
  env.ports.state.readResumeState = async () => ({
    status: "ok",
    value: { task_id: TASK, phase: "verify", status: "started" },
  });
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
  env.behavior.git.hasNewHeadSince = true;
  env.behavior.git.changedProductPaths = ["src/contract.ts"];
  env.ports.integrationGate = {
    mode: async () => "advisory",
    readContractFile: async () => ({ present: true, text: "export const a = 1;\n" }),
  };
  const coordinator = createRunCoordinator(env.ports);
  const result = await coordinator.resume("active", activeFile);
  assert.equal(result, true, "advisory verdiktas done eigos nekeičia");
  assert.ok(env.logs.some((line) => line.includes("TASK INTEGRATION REVIEW:") && line.includes("mode=advisory")));
  assert.ok(env.journalEvents.some((event) => event.to_state === "integration-review"));
  assert.ok(env.files.has(fakeBucketPath("done", TASK_MD)));
});
