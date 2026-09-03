// VQ-304 (1 dalis): dispatch/verify/repair use case'ų unit testai su fake TaskRunPorts.
// Fail-closed kryptys (sugadintas decision → human-review, infrastruktūros exit → abort
// deskriptorius, veto prieš vykdytoją → originalaus teksto atstatymas) yra kontraktas.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PolicyConfigError } from "../shared/errors.js";
import { POLICY_CONFIG_INVALID_EXIT_CODE } from "../shared/exit-codes.js";
import { createTaskRunState } from "../application/task-execution/task-run-state.js";
import { dispatchTask, runPreDispatchGates } from "../application/task-execution/dispatch-task.js";
import { verifyTask } from "../application/task-execution/verify-task.js";
import { repairTask } from "../application/task-execution/repair-task.js";
import { authorizeLlmCall } from "../application/token-governance/tool-budget-gates.js";
import { coordinatorPolicyPort } from "../composition/loop/coordinator-execution-adapters.js";
import { loadProjectProfile } from "../composition/agent/preflight-adapters.js";
import { policyConfigFs, tokenBudgetPorts } from "../composition/runtime/node-adapters.js";
import { resolveDispatchRoutingPlan } from "../interfaces/cli/dispatch/claude-dispatch/dispatch-routing-plan.js";
import {
  loadModelsEnv,
  modelTierOfRoutingTier,
  resolveRoutedModel,
  routingTierOfSelection,
} from "../infrastructure/adapters/claude-model-env.js";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";
import { createFakeTaskRunEnv, fakeBucketPath, type FakeTaskRunEnv } from "./helpers/fake-task-run-ports.js";
import type { CoordinatorAdapterInput } from "../composition/loop/coordinator-adapters.js";
import type { TaskBucket } from "../domain/tasks/index.js";

const TASK = "0042";
const TASK_MD = `${TASK}.md`;

async function makeState(env: FakeTaskRunEnv, bucket: TaskBucket = "delegated", body = "# Task\n## Tikslas\nX") {
  const file = fakeBucketPath(bucket, TASK_MD);
  env.files.set(file, body);
  const state = await createTaskRunState(file, env.ports, { interrupted: bucket !== "queue" });
  return { state, file };
}

test("runPreDispatchGates: sugadintas decision.json → human-review dar prieš adapterio vartus", async () => {
  const env = createFakeTaskRunEnv();
  env.behavior.decision = { status: "invalid", cause: "corrupted" };
  const { state, file } = await makeState(env);
  const result = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: false });
  assert.equal(result.kind, "human-review");
  assert.match((result as { reason: string }).reason, /corrupted_decision_json=1/);

  // Task 041-a: svetimas sprendimas parkuoja su NUOSAVYBĖS, ne turinio priežastimi; vartas nepakitęs.
  env.behavior.decision = { status: "invalid", cause: "foreign", decisionTaskId: "kitas-task-id" };
  const foreign = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: false });
  assert.equal(foreign.kind, "human-review");
  assert.match((foreign as { reason: string }).reason, /foreign_decision_task_id=kitas-task-id/);
  assert.doesNotMatch((foreign as { reason: string }).reason, /corrupted_decision_json/);
});

test("runPreDispatchGates: adapterio rolės draudimas → human-review; konfigo gedimas → infrastruktūra", async () => {
  const env = createFakeTaskRunEnv();
  env.behavior.adapterAssert = () => {
    throw new Error("rolė neleidžia claude");
  };
  const { state, file } = await makeState(env);
  const denied = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: false });
  assert.equal(denied.kind, "human-review");
  assert.match((denied as { reason: string }).reason, /adapter_not_allowed=/);

  env.behavior.adapterAssert = () => {
    throw new PolicyConfigError("vq/config/agents.json", new Error("bad json"));
  };
  const config = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: false });
  assert.equal(config.kind, "infrastructure");
  assert.equal((config as { exitCode: number }).exitCode, POLICY_CONFIG_INVALID_EXIT_CODE);
  assert.equal((config as { stage: string }).stage, "context-pack-config");
  assert.equal((config as { detail?: string }).detail, "config=vq/config/agents.json");
});

test("runPreDispatchGates: context-pack klaida — advisory repair'ui, blokas normaliam dispatch'ui", async () => {
  const env = createFakeTaskRunEnv();
  env.behavior.contextPack = () => {
    throw new Error("no Failai section");
  };
  const { state, file } = await makeState(env);

  const advisory = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: true });
  assert.equal(advisory.kind, "ok", "repair dispatch'ui context-pack klaida yra patariamoji");
  assert.ok(env.logs.some((line) => line.includes("BUDGET ENFORCEMENT ADVISORY")));

  const blocked = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: false });
  assert.equal(blocked.kind, "human-review");
  assert.match((blocked as { reason: string }).reason, /context_pack_failed=/);

  env.behavior.contextPack = () => {
    throw new PolicyConfigError("vq/config/context.json", new Error("corrupt"));
  };
  const config = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: true });
  assert.equal(config.kind, "infrastructure", "konfigo gedimas nevirsta advisory net repair'ui");
});

// 017 (2026-08-25, audito P1-1): vartai tikrina ROUTING'O modelį, ne preflight pasirinkimą.
test("runPreDispatchGates: enforceBudget gauna routed modelį; routing klaida — garsus fallback į decision modelį", async () => {
  const env = createFakeTaskRunEnv();
  env.behavior.decision = { status: "ok", decision: { verdict: "delegate", selected_model: "opus" } };
  // Routing'as (pvz. biudžeto downgrade) parenka haiku, nors decision skelbia opus.
  env.behavior.routedModelClass = async () => "haiku";
  const { state, file } = await makeState(env);
  const routed = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: false });
  assert.equal(routed.kind, "ok");
  assert.deepEqual(env.budgetModels, ["haiku"], "vartai tikrino realiai dispatch'insimą modelį, ne opus");

  // Routing'o infrastruktūrinė klaida neparkuoja task'o: krentama į decision modelį SU log'u.
  env.budgetModels.length = 0;
  env.logs.length = 0;
  env.behavior.routedModelClass = async () => {
    throw new Error("routing policy unreadable");
  };
  const fallback = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: false });
  assert.equal(fallback.kind, "ok");
  assert.deepEqual(env.budgetModels, ["opus"], "fallback — decision modelis (senoji patikra geriau nei jokios)");
  assert.ok(env.logs.some((line) => line.includes("DISPATCH MODEL GATE FALLBACK")));

  // Draudžiamas routed modelis blokuoja, nors decision modelis būtų leidžiamas.
  env.budgetModels.length = 0;
  env.behavior.routedModelClass = async () => "haiku";
  env.behavior.budgetOk = false;
  env.behavior.budgetReasons = ["model not allowed: haiku"];
  const vetoed = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: false });
  assert.equal(vetoed.kind, "human-review");
  assert.match((vetoed as { reason: string }).reason, /model not allowed: haiku/);
});

test("runPreDispatchGates: biudžeto veto → human-review su priežastimis", async () => {
  const env = createFakeTaskRunEnv();
  env.behavior.budgetOk = false;
  env.behavior.budgetReasons = ["ceiling", "tier"];
  const { state, file } = await makeState(env);
  const result = await runPreDispatchGates(state, env.ports, { promptFile: file, isRepair: false });
  assert.equal(result.kind, "human-review");
  assert.match((result as { reason: string }).reason, /budget_enforcement_failed=ceiling; tier/);
});

test("dispatchTask: sėkmė perkelia į active, fiksuoja ledger/checkpoint ir grąžina fingerprint", async () => {
  const env = createFakeTaskRunEnv();
  const { state, file } = await makeState(env);
  const result = await dispatchTask(state, env.ports, { promptFile: file, fromTaskFile: file, isRepair: false });
  assert.equal(result.kind, "ok");
  const activePath = fakeBucketPath("active", TASK_MD);
  assert.equal((result as { activeFile: string }).activeFile, activePath);
  assert.ok(env.files.has(activePath), "failas perkeltas į active bucket'ą");
  assert.ok(env.cliCalls.some((args) => args[0] === "claude-dispatch" && args.includes("--task-id") && args.includes(TASK)));
  assert.deepEqual(env.ledgerRecords.at(-1), { taskId: TASK, state: "active", file: activePath });
  assert.equal(env.checkpoints.at(-1)?.phase, "post-claude-diagnosis");
});

test("dispatchTask: veto prieš vykdytoją pažymimas preExecution ir nevykdo claude-dispatch", async () => {
  const env = createFakeTaskRunEnv();
  env.behavior.decision = { status: "invalid", cause: "corrupted" };
  const { state, file } = await makeState(env);
  const result = await dispatchTask(state, env.ports, { promptFile: file, fromTaskFile: file, isRepair: false });
  assert.equal(result.kind, "human-review");
  assert.equal((result as { preExecution?: true }).preExecution, true);
  assert.equal(env.cliCalls.length, 0, "vykdytojas nepaleistas");
});

test("dispatchTask: infrastruktūros gedimas ir usage-error atsisakymas po sesijos", async () => {
  const env = createFakeTaskRunEnv();
  env.behavior.cli = () => 77;
  env.behavior.dispatchInfrastructureFailure = true;
  const { state, file } = await makeState(env);
  const infra = await dispatchTask(state, env.ports, { promptFile: file, fromTaskFile: file, isRepair: false });
  assert.equal(infra.kind, "infrastructure");
  assert.equal((infra as { stage: string }).stage, "dispatch");
  assert.equal((infra as { preExecution?: true }).preExecution, undefined, "po sesijos veto žymės nėra");

  env.behavior.dispatchInfrastructureFailure = false;
  env.behavior.cli = () => 2;
  const refused = await dispatchTask(state, env.ports, { promptFile: file, fromTaskFile: file, isRepair: false });
  assert.equal(refused.kind, "human-review");
  assert.match((refused as { reason: string }).reason, /dispatch_refused=2/);
});

function verifyEnv(): { env: FakeTaskRunEnv } {
  const env = createFakeTaskRunEnv();
  // quality-gates=0, diagnose=0 pagal nutylėjimą.
  env.behavior.cli = () => 0;
  return { env };
}

test("verifyTask: infrastruktūrinis quality-gates exit nutraukia PRIEŠ diagnozę", async () => {
  const { env } = verifyEnv();
  env.behavior.cli = (args) => (args[0] === "quality-gates" ? 78 : 0);
  const { state } = await makeState(env, "active");
  const result = await verifyTask(state, env.ports, { diagnoseCmd: "claude-diagnose" });
  assert.deepEqual(result, { kind: "infrastructure", stage: "quality-gates", exitCode: 78 });
  assert.equal(env.cliCalls.filter((args) => args[0] === "claude-diagnose").length, 0);
  assert.equal(env.phaseFailures.at(-1)?.phase, "quality-gates");
});

test("verifyTask: diagnozės kritimas — infra kodas → abort, kitaip human-review", async () => {
  const { env } = verifyEnv();
  env.behavior.cli = (args) => (args[0] === "claude-diagnose" ? { code: 124, output: "timeout" } : 0);
  const { state } = await makeState(env, "active");
  const infra = await verifyTask(state, env.ports, { diagnoseCmd: "claude-diagnose" });
  assert.deepEqual(infra, { kind: "infrastructure", stage: "diagnose", exitCode: 124 });

  env.behavior.cli = (args) => (args[0] === "claude-diagnose" ? { code: 3, output: "boom" } : 0);
  const parked = await verifyTask(state, env.ports, { diagnoseCmd: "claude-diagnose" });
  assert.equal(parked.kind, "human-review");
  assert.match((parked as { reason: string }).reason, /supervisor_diagnose_failed=3/);
});

test("verifyTask: verdiktų maršrutai — repair, rollback_stop/human_review, nežinomas", async () => {
  const { env } = verifyEnv();
  const { state } = await makeState(env, "active");
  env.behavior.decision = { status: "ok", decision: { verdict: "repair" } };
  assert.deepEqual(await verifyTask(state, env.ports, { diagnoseCmd: "d" }), { kind: "repair" });

  env.behavior.decision = { status: "ok", decision: { verdict: "rollback_stop", reason: "r" } };
  const rollback = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.equal(rollback.kind, "rollback-human-review");

  env.behavior.decision = { status: "ok", decision: { verdict: "wat" } };
  const unknown = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.equal(unknown.kind, "human-review");
  assert.match((unknown as { reason: string }).reason, /UNKNOWN DIAGNOSIS VERDICT/);

  env.behavior.decision = { status: "invalid", cause: "corrupted" };
  const corrupted = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.match((corrupted as { reason: string }).reason, /corrupted_decision_json=1/);
  env.behavior.decision = { status: "invalid", cause: "foreign", decisionTaskId: "svetimas" };
  const foreign = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.match((foreign as { reason: string }).reason, /foreign_decision_task_id=svetimas/);
});

test("verifyTask: done su produkto commit'ais → done; be jų — marker/clean-tree/parkas", async () => {
  const { env } = verifyEnv();
  const { state } = await makeState(env, "active");
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
  env.behavior.git.hasNewHeadSince = true;
  env.behavior.git.changedProductPaths = ["src/x.ts"];
  assert.deepEqual(await verifyTask(state, env.ports, { diagnoseCmd: "d" }), { kind: "done" });

  // Markeris + darbo įrodymas istorijoje → done-already-implemented via marker.
  env.behavior.git.hasNewHeadSince = false;
  env.behavior.git.changedProductPaths = [];
  env.behavior.claudeLog = "ALREADY_IMPLEMENTED: viskas yra";
  env.behavior.git.committedProductWorkSha = "abc";
  const marker = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.deepEqual(marker, { kind: "done-already-implemented", via: "marker" });

  // Švarus medis + įrodymas be markerio → via clean-tree.
  env.behavior.claudeLog = "";
  const clean = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.deepEqual(clean, { kind: "done-already-implemented", via: "clean-tree" });

  // Švarus medis BE įrodymo → rollback-stable + parkas su evidence priežastimi.
  env.behavior.git.committedProductWorkSha = undefined;
  const parked = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.equal(parked.kind, "human-review");
  assert.match((parked as { reason: string }).reason, /clean tree without work evidence/);
  assert.ok(env.cliCalls.some((args) => args[0] === "rollback-stable"));
  // Purvinas medis be markerio (rollback šaka, missing-commit parkas) tikrinamas 141-c teste
  // žemiau — ten ta pati baigtis tvirtinama anksčiau su tikslia, prie galo pririšta žinute.
});

// 141-c: „commit missing" (rašymai buvo ir tebeguli medyje — neįvyko commit'as, Stop hook'o
// kelias, task 141) ir „work missing" (rašymo įrankis nekviestas nė karto) yra dvi skirtingos
// šaknys po ta pačia human-review baigtimi; `unknown` log'as neįrodo nė vienos, tad jam lieka
// iki šiol buvusi žinutė. Verdiktas visur nepakitęs — TIK įvardijimas (032 signalas + 141-c).
test("verifyTask: rašymo aktyvumas įvardija commit missing vs work missing (032, 141-c)", async () => {
  const { env } = verifyEnv();
  const { state } = await makeState(env, "active");
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
  env.behavior.git.hasNewHeadSince = false;
  env.behavior.git.changedProductPaths = [];
  env.behavior.git.committedProductWorkSha = undefined;
  const toolLog = (tool: string) => `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"${tool}"}]}}`;
  const reasonFor = async (claudeLog: string, productDirtyCount: number): Promise<string> => {
    env.behavior.claudeLog = claudeLog;
    env.behavior.git.productDirtyCount = productDirtyCount;
    const result = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
    assert.equal(result.kind, "human-review", "verdiktas nepakitęs — keičiasi tik įvardijimas");
    return (result as { reason: string }).reason;
  };
  // Tik Read: rašymo įrankis nekviestas nė karto → darbo nebuvo, ieškoti operatoriui nėra ko.
  assert.match(await reasonFor(toolLog("Read"), 0), /^TASK NOT DONE: 0042 work_missing=1 executor made no write-tool calls$/);
  // Rašymai buvo IR tebeguli medyje → darbas nedingo, tiesiog neįvyko commit'as.
  const dirty = await reasonFor(toolLog("Write"), 2);
  assert.match(dirty, /^TASK NOT DONE: 0042 commit_missing=1 writes present, tree dirty, no commit/);
  assert.doesNotMatch(dirty, /work_missing|executor made no write-tool calls/);
  // Rašymai buvo, bet medis švarus ir įrodymo istorijoje nėra → nė vienas teiginys neįrodytas.
  const rolledBack = await reasonFor(toolLog("Write"), 0);
  assert.match(rolledBack, /clean tree without work evidence/);
  assert.doesNotMatch(rolledBack, /commit_missing|work_missing/);
  // Neatpažintas (tuščias) log'as nėra įrodymas → žinutė lieka tokia, kokia buvo iki 141-c.
  assert.match(await reasonFor("", 2), /^TASK NOT DONE: 0042 Claude did not create a new commit$/);
});

test("verifyTask: 018 seka — rollback išsaugo necommit'intą darbą, priežastyje matoma vieta", async () => {
  const { env } = verifyEnv();
  const { state } = await makeState(env, "active");
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
  // Ledger'yje 2 nuosavi produkto keliai (018: capture-baseline.ts, baseline-report.ts),
  // commit'o nėra — tiksliai ta baigtis, kuri anksčiau sunaikindavo darbą tyliai.
  env.behavior.git.productDirtyCount = 2;
  env.behavior.git.committedProductWorkSha = undefined;
  env.behavior.cli = (args) =>
    args[0] === "rollback-stable"
      ? {
          code: 0,
          output:
            "ROLLBACK PRESERVED: task=0042 ref=refs/verqestra/preserved/deadbeef commit=deadbeef paths=2 record=/vq/state/rollback-preserved/0042.json\nROLLBACK TASK-SCOPED: restored 2 task path(s) to 88a695cc",
        }
      : 0;
  const result = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.equal(result.kind, "human-review");
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /^TASK NOT DONE: 0042 Claude did not create a new commit preserved_work=refs\/verqestra\/preserved\/deadbeef$/);
  assert.ok(env.cliCalls.some((args) => args[0] === "rollback-stable"));
});

test("verifyTask: done vartai — raudoni gates, korumpuotas/svetimas/error stop status", async () => {
  const { env } = verifyEnv();
  const { state } = await makeState(env, "active");
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };

  env.behavior.cli = (args) => (args[0] === "quality-gates" ? 1 : 0);
  const redGates = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.match((redGates as { reason: string }).reason, /quality_gates_failed=1/);

  env.behavior.cli = () => 0;
  env.behavior.stopStatus = { status: "corrupted", error: "bad json" };
  const corrupted = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.match((corrupted as { reason: string }).reason, /stop_status_corrupted=1/);

  env.behavior.stopStatus = { status: "ok", value: { status: "error", task_id: TASK } };
  const stopError = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.match((stopError as { reason: string }).reason, /stop_status=error/);

  // Svetimo task'o error stop status IGNORUOJAMAS — kelias eina toliau (čia: done per commit'us).
  env.behavior.stopStatus = { status: "ok", value: { status: "error", task_id: "kitas" } };
  env.behavior.git.hasNewHeadSince = true;
  env.behavior.git.changedProductPaths = ["src/x.ts"];
  assert.deepEqual(await verifyTask(state, env.ports, { diagnoseCmd: "d" }), { kind: "done" });
  assert.ok(env.logs.some((line) => line.includes("foreign claude-stop-status.json")));
});

test("repairTask: retry-guard infra kodas → abort be rollback; limitas → rollback + retry-limit", async () => {
  const env = createFakeTaskRunEnv();
  const { state } = await makeState(env, "active");
  env.behavior.cli = (args) => (args[0] === "retry-guard" ? 78 : 0);
  const infra = await repairTask(state, env.ports);
  assert.deepEqual(infra, { kind: "infrastructure", stage: "retry-guard", exitCode: 78 });
  assert.equal(env.cliCalls.filter((args) => args[0] === "rollback-stable").length, 0, "rollback praleistas");

  env.behavior.cli = (args) => (args[0] === "retry-guard" ? 1 : 0);
  const limit = await repairTask(state, env.ports);
  assert.deepEqual(limit, { kind: "retry-limit" });
  assert.ok(env.cliCalls.some((args) => args[0] === "rollback-stable"));

  env.behavior.cli = (args) => (args[0] === "retry-guard" ? 1 : args[0] === "rollback-stable" ? 5 : 0);
  const rollbackFailed = await repairTask(state, env.ports);
  assert.equal(rollbackFailed.kind, "human-review");
  assert.match((rollbackFailed as { reason: string }).reason, /rollback_failed=5 retry_limit/);
});

test("repairTask: trūkstamas prompt'as — parkas, o sėkmės kelyje (done+žali gates) → redispatched vieną kartą", async () => {
  const env = createFakeTaskRunEnv();
  const { state } = await makeState(env, "active");
  env.behavior.cli = () => 0;
  env.behavior.repairPrompt = "";
  env.behavior.decision = { status: "ok", decision: { verdict: "repair" } };
  state.lastQualityGateExitCode = 1;
  const parked = await repairTask(state, env.ports);
  assert.equal(parked.kind, "human-review");
  assert.match((parked as { reason: string }).reason, /task_scoped_repair_prompt_missing=1/);

  state.lastQualityGateExitCode = 0;
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
  const rerouted = await repairTask(state, env.ports);
  assert.deepEqual(rerouted, { kind: "redispatched" }, "sėkmės kelias grąžinamas verifikacijai");
  const second = await repairTask(state, env.ports);
  assert.equal(second.kind, "human-review", "išimtis galioja tik kartą per run'ą");
});

test("repairTask: pilnas repair — prompt tampa error kūnu, redispatch per kanoninius vartus", async () => {
  const env = createFakeTaskRunEnv();
  const { state } = await makeState(env, "active", "# Task\noriginalas");
  env.behavior.cli = () => 0;
  env.behavior.repairPrompt = "# Repair Task\npataisyk X";
  const result = await repairTask(state, env.ports);
  assert.deepEqual(result, { kind: "redispatched" });
  const activeBody = env.files.get(fakeBucketPath("active", TASK_MD));
  assert.equal(activeBody, "# Repair Task\npataisyk X", "repair prompt'as keliavo per error → active");
  assert.ok(env.checkpoints.some((cp) => cp.phase === "post-claude-repair-diagnosis"));
});

test("repairTask: veto prieš vykdytoją atstato originalų tekstą error bucket'e (repair-clobber)", async () => {
  const env = createFakeTaskRunEnv();
  const { state } = await makeState(env, "active", "# Task\noriginalas");
  env.behavior.cli = () => 0;
  env.behavior.repairPrompt = "# Repair Task\npataisyk X";
  env.behavior.budgetOk = false;
  env.behavior.budgetReasons = ["ceiling"];
  const result = await repairTask(state, env.ports);
  assert.equal(result.kind, "human-review");
  const errorBody = env.files.get(fakeBucketPath("error", TASK_MD));
  assert.equal(errorBody, "# Task\noriginalas", "originalus tekstas atstatytas peržiūrai");
  assert.ok(env.logs.some((line) => line.includes("TASK REPAIR PROMPT REVERTED")));
  assert.equal(env.cliCalls.filter((args) => args[0] === "claude-dispatch").length, 0);
});

// 017-A-02: vartų adapteris ir claude-dispatch routing'as yra DU kviečiai to paties
// `routeModel`. Jei jų įėjimai išsiskirtų, `enforceBudget` vetuotų modelį, kurio niekas
// nepaleis (arba praleistų tą, kurį paleis), tad sutapimas tikrinamas realiais adapteriais —
// tikra runtime šaknimi, tikrais retry skaitikliais ir tuo pačiu task tekstu.
const ROUTED_TASK = [
  "# Task",
  "## Tikslas",
  "Surišti maršruto skaičiavimą su biudžeto vartais.",
  "## Failai",
  "Leidžiama:",
  "- `src/composition/loop/coordinator-execution-adapters.ts`",
  "- `src/tests/task-execution-run.test.ts`",
  "## Veiksmas",
  "- Realizuoti adapterį.",
  "- Patikrinti determinizmą.",
  "## Patikra",
  "- `pnpm test`",
].join("\n");

function routingAdapterInput(projectRoot: string, runtimeRoot: string): CoordinatorAdapterInput {
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

test("resolveDispatchModelClass: vartų modelis sutampa su dispatch'inamu, o klaida propaguojasi", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-017-a-02-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  const gateRequest = { promptFile: "", taskId: TASK, phase: "implementation" as const, selectedModel: "sonnet" };
  try {
    await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
    await mkdir(path.join(runtimeRoot, "project"), { recursive: true });
    gateRequest.promptFile = path.join(projectRoot, TASK_MD);
    await writeFile(gateRequest.promptFile, ROUTED_TASK, "utf8");
    await writeFile(
      path.join(runtimeRoot, "project", "profile.json"),
      JSON.stringify({ source_roots: ["src"] }),
      "utf8",
    );
    // Dvi nesėkmės (default defer_steps=1) — eskalacijos šaka, kur nesutapimas skaudžiausias:
    // vartai tikrintų bazinę pakopą, o dispatch'as paleistų pakeltą.
    const retryCountsFile = path.join(runtimeRoot, "state", "retry-counts.json");
    await writeFile(retryCountsFile, JSON.stringify({ [`task:${TASK}`]: 2 }), "utf8");
    const policy = coordinatorPolicyPort(routingAdapterInput(projectRoot, runtimeRoot));

    const gateModel = await policy.resolveDispatchModelClass(gateRequest);
    const modelsEnv = await loadModelsEnv(runtimeRoot);
    const plan = await resolveDispatchRoutingPlan({
      runtimeRoot,
      taskId: TASK,
      taskText: ROUTED_TASK,
      phase: "implementation",
      decision: { selected_model: gateRequest.selectedModel },
      selectedModel: gateRequest.selectedModel,
      failedAttempts: 2,
      authorization: await authorizeLlmCall(tokenBudgetPorts(runtimeRoot), runtimeRoot, {
        taskId: TASK,
        phase: "implementation",
      }),
      policyFs: policyConfigFs,
      models: {
        routingTierOfSelection,
        modelTierOfRoutingTier,
        resolveRoutedModel: (tier) => Promise.resolve(resolveRoutedModel(tier, modelsEnv)),
      },
      projectProfile: await loadProjectProfile(runtimeRoot),
      logDispatch: async () => {},
    });

    assert.equal(gateModel, plan.effectiveTier, "vartai tikrina TĄ PATĮ modelį, kurį paleis dispatch'as");
    assert.notEqual(plan.routing.tier, plan.routing.base_tier, "eskalacijos šaka realiai išbandyta");
    assert.equal(await policy.resolveDispatchModelClass(gateRequest), gateModel, "tie patys įėjimai — tas pats modelis");

    // Sugadinti retry skaitikliai: adapteris META. Tylus nusileidimas į 0 bandymų reikštų, kad
    // vartai patikrino PRIEŠ eskalaciją buvusį modelį — kvietėjas apie tai nė nesužinotų.
    await writeFile(retryCountsFile, "[]", "utf8");
    await assert.rejects(() => policy.resolveDispatchModelClass(gateRequest), /retry counts file is corrupt/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
