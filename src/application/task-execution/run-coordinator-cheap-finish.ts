/**
 * Cheap finish kelias (etalono task 0000-0-repair-cheap-finish; VQ-304 2/3 skaidymo dalis).
 *
 * VIENAS papildomas, griežtai apribotas dispatch'as, kai vienintelė likusi klaida yra viena
 * mechaninė (typecheck/test) klaida, produkto darbas jau egzistuoja, o task'ą stabdo biudžeto
 * lubos arba retry limitas. Sprendimo taisyklės — grynos (`token-governance/cheap-finish.ts`
 * `decideCheapFinish`); čia — tik seka ir efektai per port'us.
 */
import { decideCheapFinish } from "../token-governance/cheap-finish.js";
import type { TaskRunPorts } from "./run-coordinator-ports.js";
import type { TaskRunState } from "./task-run-state.js";
import { composeCheapFinishPrompt, looksLikeRepairDispatchPrompt } from "./run-coordinator-guards.js";
import { dispatchTask } from "./dispatch-task.js";
import { applyTerminal, stopRun } from "./run-coordinator-terminal.js";
import type { CheapFinishOutcome } from "./run-coordinator-model.js";

function cheapFinishSignalOf(diagnosisReason: string): string | undefined {
  return /^local-diagnosis:\s*clear local issue:\s*(.+)$/.exec(diagnosisReason.trim())?.[1]?.trim();
}

/**
 * VIENAS cheap finish bandymas.
 *
 * Du kvietimo taškai verifikacijos cikle, ir jų tvarka yra kontrakto dalis:
 *   - `pre-repair`  — PRIEŠ `repairTask()`, nes `repair-task.ts` retry limito šakoje paleidžia
 *     DESTRUKTYVŲ `rollback-stable` dar prieš grąžindamas `retry-limit`; po jo produkto darbo,
 *     kurį cheap finish turėtų užbaigti, nebėra;
 *   - `post-veto`   — PO `repairTask()` grąžinto `human-review`, kai priežastis yra biudžeto
 *     veto. Toks verdiktas visada kyla `runPreDispatchGates` viduje (vykdytojas nepaleistas),
 *     tad failas jau guli `error` bucket'e su ATSTATYTU originaliu tekstu.
 *
 * Fail-closed visur: nė vienas žingsnis negali palikti task'o blogesnėje būsenoje, nei jis
 * būtų buvęs be cheap finish — nepavykus context-pack'ui ar paruošimui, kūnas atstatomas ir
 * grąžinamas `not-armed`, t. y. įprastas human-review / retry limito kelias.
 */
export async function tryCheapFinish(
  ports: TaskRunPorts,
  state: TaskRunState,
  trigger: { stage: "pre-repair" | "post-veto"; budgetVetoReason?: string },
): Promise<CheapFinishOutcome> {
  const cheapFinish = ports.cheapFinish;
  // Port'o nebuvimas = mechanizmas neprijungtas: nė vieno papildomo skaitymo, tad kelias
  // lieka baitas-į-baitą toks pat, koks buvo iki šio mechanizmo atsiradimo.
  //
  // `cheapFinishArmed` (o ne `cheapFinishUsed`) yra in-run pakartotinio įėjimo saugiklis:
  // vieną kartą paruoštas cheap finish antro bandymo tame pačiame run'e negauna net tada, kai
  // paruošimas ar dispatch'as nepavyko.
  if (!cheapFinish || state.cheapFinishArmed === true || state.cheapFinishUsed === true) {
    return { kind: "not-armed" };
  }

  const decisionResult = await ports.state.readDecision(state.taskId);
  if (decisionResult.status === "invalid") {
    return { kind: "not-armed" };
  }
  const diagnosisReason = decisionResult.decision.reason ?? "";
  const signal = cheapFinishSignalOf(diagnosisReason);
  // Pigus išankstinis filtras: be deterministinio signalo nėra prasmės klausti nei git, nei
  // žymės, nei retry biudžeto. Sprendimą vis tiek priima `decideCheapFinish`.
  if (!signal) {
    return { kind: "not-armed" };
  }

  const marker = await cheapFinish.read(state.taskId);
  const retryBudget = await cheapFinish.retryBudget(state.taskId);
  const dirtyCount = await ports.git.productDirtyCount();
  const committedSha = dirtyCount > 0 ? undefined : await ports.git.committedProductWorkShaFor(state.taskId);

  const decision = decideCheapFinish({
    ...(decisionResult.decision.verdict === undefined ? {} : { verdict: decisionResult.decision.verdict }),
    diagnosisReason,
    hasUncommittedProductWork: dirtyCount > 0,
    hasCommittedProductWork: Boolean(committedSha),
    ...(trigger.budgetVetoReason === undefined ? {} : { budgetVetoReason: trigger.budgetVetoReason }),
    // Prognozė galioja TIK prieš `repairTask()`: po jo `retry-guard` skaitiklį jau padidino,
    // tad tas pats klausimas duotų kitą (jau pasenusį šiam sprendimui) atsakymą.
    retryLimitPredicted: trigger.stage === "pre-repair" && retryBudget.nextWouldReachLimit,
    alreadyArmed: marker.status === "armed",
  });
  if (!decision.eligible) {
    return { kind: "not-armed" };
  }

  // Retry limito kelyje task'as dar guli ten, kur jį paliko dispatch'as: perkeliame į `error`
  // patys, nes `repairTask()` (kuris tai daro įprastame kelyje) čia nebus kviečiamas.
  if (trigger.stage === "pre-repair") {
    const currentFile = await state.resolveCurrentTaskFile();
    if (ports.tasks.bucketOf(currentFile) !== "error") {
      const movedErrorFile = await ports.tasks.move(currentFile, "error", state.taskName);
      state.errorFile = state.remember(movedErrorFile);
    } else {
      state.errorFile = state.remember(currentFile);
    }
  }

  const originalTaskBody = await ports.tasks.readTaskBody(state.errorFile).catch(() => undefined);
  if (originalTaskBody === undefined) {
    // Be originalaus kūno nebūtų nei `## Failai` ribų, nei `## Agentai` rolės — dispatch'as
    // arba būtų vetuotas, arba dirbtų be ribų. Abu blogesni už įprastą kelią.
    await ports.log.write(`CHEAP FINISH SKIPPED: task=${state.taskId} reason=task_body_unreadable`);
    return { kind: "not-armed" };
  }

  const prompt = composeCheapFinishPrompt({
    taskBody: originalTaskBody,
    signal,
    repairContext: await ports.repairPrompt.read(state.taskId).catch(() => ""),
  });
  if (looksLikeRepairDispatchPrompt(prompt)) {
    await ports.log.write(`CHEAP FINISH SKIPPED: task=${state.taskId} reason=repair_shaped_prompt`);
    return { kind: "not-armed" };
  }

  /** Vieno rašytojo (šio kelio) kūno + fingerprint + ledger'io atnaujinimas. */
  const publishTaskBody = async (body: string): Promise<void> => {
    await ports.tasks.writeTaskBody(state.errorFile, body);
    const fingerprint = await ports.tasks.fingerprint(state.errorFile);
    // eslint-disable-next-line require-atomic-updates -- single-writer TaskRunState mutation (ownership doc in run-coordinator.ts)
    state.fingerprint = fingerprint;
    await ports.ledger.recordState(state.taskId, state.taskName, "error", state.errorFile, fingerprint);
  };

  const restoreOriginalBody = async (reason: string): Promise<void> => {
    await publishTaskBody(originalTaskBody);
    await ports.log.write(`CHEAP FINISH ABORTED: task=${state.taskId} reason=${reason}`);
  };

  await publishTaskBody(prompt);

  // Vykdymo konteksto REGENERACIJA yra sąlyga, ne patogumas: prompt'as pasikeitė, tad senas
  // `execution-context.md` nebeatitinka fingerprint'o ir `AG_EXECUTION_CONTEXT_MODE=required`
  // dispatch'ą atmestų. Klaida čia = cheap finish neįjungiamas.
  try {
    await ports.policy.buildContextPack(state.errorFile);
  } catch (error: unknown) {
    await restoreOriginalBody(`context_pack_failed=${error instanceof Error ? error.message : String(error)}`);
    return { kind: "not-armed" };
  }

  // Žymė rašoma PRIEŠ paruošimą ir dispatch'ą: jei kas nors po jos nepavyktų, cheap finish
  // laikomas panaudotu. Tai sąmoningai konservatyvu — vienas prarastas bandymas yra pigesnis
  // už riziką, kad tas pats task'as gautų antrą papildomą dispatch'ą.
  //
  // Bet „bandyta paruošti" NĖRA „dispatch'inta": `cheapFinishUsed` keliama tik žemiau, po
  // realaus dispatch'o (žr. jos komentarą tipe), kad nepavykęs paruošimas nevirstų nei
  // `cheap_finish_failed=1` telemetrija, nei prarastu įprastu repair ratu.
  await cheapFinish.arm({
    schema_version: 1,
    task_id: state.taskId,
    armed_at: new Date().toISOString(),
    // `a<n>` = retry skaitiklis + 1, o cheap finish dirbs KITAME bandyme, nes `prepareDispatch`
    // tą skaitiklį padidina. Tikslią reikšmę po paruošimo grąžina `prepared.attemptSequence`
    // ir ji keliauja į telemetriją.
    attempt_sequence: retryBudget.count + 2,
    reason_class: decision.class,
    blocked_by: decision.blockedBy,
    billable_limit: decision.billableLimit,
    max_turns: decision.maxTurns,
  });
  // eslint-disable-next-line require-atomic-updates -- single-writer TaskRunState mutation (ownership doc in run-coordinator.ts)
  state.cheapFinishArmed = true;

  const prepared = await cheapFinish.prepareDispatch({
    taskId: state.taskId,
    promptText: prompt,
    desiredTierStep: 1,
    tokenBudgetTier: "small",
    resetTaskLedger: decision.requiresLedgerReset,
  });
  if (!prepared.ok) {
    // ŽINOMAS APRIBOJIMAS: `prepareDispatch` retry skaitiklį didina savo viduje ir dalis jo
    // gedimų kyla JAU po inkremento (attempt namespace, `decision.json`, biudžeto epocha).
    // Atšaukimo operacijos port'as neturi, tad toks bandymas įprastam repair ratui vieną
    // retry vis tiek kainuoja; `cheapFinishUsed` nekeliama, todėl bent verdiktas ir
    // telemetrija lieka teisingi (įprastas kelias, o ne `cheap_finish_failed=1`).
    await restoreOriginalBody(`prepare_failed=${prepared.errors.join("; ")}`);
    return { kind: "not-armed" };
  }

  const evidenceLabel = dirtyCount > 0 ? "dirty" : "commit";
  await ports.log.write(
    `REPAIR CHEAP-FINISH: task=${state.taskId} reason=${decision.class} budget=${decision.billableLimit}` +
      ` blocked_by=${decision.blockedBy} evidence=${evidenceLabel} max_turns=${decision.maxTurns}` +
      ` model=${prepared.selectedModel} attempt=a${prepared.attemptSequence}` +
      ` ledger_reset=${decision.requiresLedgerReset ? 1 : 0}`,
  );
  // Skaičiai keliauja į `detail`, o ne į `reason`: learning emiteris normalizuoja būtent
  // `reason` į failure_signature, tad kintami dydžiai jame subyrėtų į unikalius parašus
  // (ta pati taisyklė kaip `TaskJournalPort.recordEvent` dokumentacijoje).
  await ports.journal.recordEvent({
    task_id: state.taskId,
    to_state: "error",
    phase: "cheap-finish",
    reason: `cheap_finish_armed=1 class=${decision.class} blocked_by=${decision.blockedBy}`,
    detail: `budget=${decision.billableLimit} turns=${decision.maxTurns} attempt=a${prepared.attemptSequence}`,
  });

  // `isRepair: false` yra struktūrinis faktas, ne spėjimas: prompt'as yra originali užduotis
  // su siauru priedu ir šviežiai regeneruotu context-pack'u, tad jam galioja įprasti
  // implementation vartai (biudžetas — su vienkartine cheap finish išimtimi kompozicijos
  // šaknyje).
  //
  // Kviečiamas TIESIOGINIS `dispatchTask`, o ne `runDispatch`: pastarasis `preExecution` žymą
  // nuryja, o be jos cheap finish kelias atkartotų 0058 „repair-clobber" defektą — vetuotas dar
  // prieš vykdytoją task'as būtų parkuotas su cheap finish prompt'u kūne vietoje originalios
  // užduoties.
  const dispatched = await dispatchTask(state, ports, {
    promptFile: state.errorFile,
    fromTaskFile: state.errorFile,
    isRepair: false,
  });
  if (dispatched.kind !== "ok") {
    if (dispatched.preExecution === true) {
      // Sesijos nebuvo: kūnas grąžinamas į originalią užduotį (fingerprint + ledger'is —
      // `restoreOriginalBody` viduje), tad žmogus human-review bucket'e ras užduotį, o ne
      // cheap finish šabloną.
      await restoreOriginalBody(`dispatch_vetoed_before_execution=${dispatched.kind}`);
    } else {
      // eslint-disable-next-line require-atomic-updates -- single-writer TaskRunState mutation (ownership doc in run-coordinator.ts)
      state.cheapFinishUsed = true;
    }
    if (dispatched.kind === "infrastructure") {
      return { kind: "terminal", result: await stopRun(ports, state, dispatched.stage, dispatched.exitCode, dispatched.detail) };
    }
    return {
      kind: "terminal",
      result: await applyTerminal(ports, state, { kind: "human-review", reason: dispatched.reason }),
    };
  }

  // eslint-disable-next-line require-atomic-updates -- single-writer TaskRunState mutation (ownership doc in run-coordinator.ts)
  state.cheapFinishUsed = true;
  return { kind: "dispatched" };
}
