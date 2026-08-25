/**
 * Dispatch use case (etalono task 1111).
 *
 * Viena seka sujungia keturis anksčiau atskirus sprendimus, kurie iki tol buvo išbarstyti
 * po kanoninį loop'ą:
 *   1. execution context — `decision.json` validacija (1102),
 *   2. model routing      — provider-neutralus modelio parinkimas iš to paties sprendimo (1109),
 *   3. token authorization — context-pack + whole-task biudžeto vartai (1103),
 *   4. adapter routing     — task'o `## Agentai` rolė turi leisti claude adapterį (889).
 *
 * Use case NEATLIEKA terminalinių perėjimų: jis grąžina deskriptorių, o
 * `run-coordinator.ts` sprendžia, kur task'as juda. Todėl čia nėra nė vieno
 * `ports.tasks.finish` / `"human-review"` bucket kvietimo.
 */
import { isUsageErrorExitCode, POLICY_CONFIG_INVALID_EXIT_CODE } from "../../shared/exit-codes.js";
import { isPolicyConfigError, type PolicyConfigError } from "../../shared/errors.js";
import type { TaskRunPorts } from "./run-coordinator-ports.js";
import type { TaskRunState } from "./task-run-state.js";

export type DispatchTaskRequest = {
  /** Failas, kurio tekstas siunčiamas vykdytojui (`delegatedFile` arba `errorFile`). */
  promptFile: string;
  /** Failas, kuris po dispatch'o perkeliamas atgal į `active`. */
  fromTaskFile: string;
  /**
   * Struktūrinis faktas, kurį kvietėjas jau žino (dispatch'ina `errorFile` ar
   * `delegatedFile`), o ne prompt turinio spėjimas — etalono task 872. Nuo jo priklauso ir
   * biudžeto fazė, ir context-pack nesėkmės traktavimas.
   */
  isRepair: boolean;
};

/** Infrastruktūros abort'o etapas dispatch use case'e. Reikšmė keliauja į `stop(stage)` ir journal `phase`. */
export type DispatchStage = "dispatch" | "context-pack-config";

/**
 * Ar verdiktas priimtas PRIEŠ vykdytojo paleidimą (etalono task 0058).
 *
 * Yra TIK ties {@link runPreDispatchGates} kilusiais atmetimais, tad kvietėjas gali saugiai
 * atšaukti tai, ką paruošė dispatch'ui: sesijos nebuvo, jokio darbo neprarandama. Po
 * `claude-dispatch` kilę verdiktai šio lauko NETURI — ten atstatymas sunaikintų repair prompt'ą,
 * su kuriuo sesija jau dirbo.
 */
type PreExecutionMark = { preExecution?: true };

export type DispatchTaskResult =
  | { kind: "ok"; activeFile: string; fingerprint: string }
  | ({ kind: "human-review"; reason: string } & PreExecutionMark)
  | ({
      kind: "infrastructure";
      stage: DispatchStage;
      exitCode: number;
      /**
       * Trumpas, operatoriui skirtas gedimo identifikatorius (pvz. `config=vq/config/agents.json`),
       * kurį `stop` įrašo į abort'o eilutę ir klaidos žinutę. Jo nesant abort'o tekstas lieka
       * nepakitęs — tai laikoma elgesio kontraktu.
       */
      detail?: string;
    } & PreExecutionMark);

type ContextPackOutcome =
  | { kind: "ok"; pack: Record<string, unknown> }
  | { kind: "advisory-skip" }
  | { kind: "blocked"; reason: string }
  | { kind: "config-error"; error: PolicyConfigError; reason: string };

type InfrastructureDispatchResult = Extract<DispatchTaskResult, { kind: "infrastructure" }>;

/**
 * VIENINTELĖ policy konfigo gedimo klasifikacija dispatch'e (etalono task 0032). Konfigą skaito
 * du šio use case'o keliai — adapterio rolės vartai ir context-pack surinkimas — bet operatoriui
 * tai vienas gedimas su vienu taisymu (sutvarkyti įvardytą failą ir paleisti loop'ą iš naujo),
 * tad abu gauna tą pačią log eilutę, tą patį `stage` ir tą patį exit kodą.
 *
 * `detail` keliauja į `stop`, kad konfigo failą matytų ir pati abort'o eilutė, o ne tik ši.
 */
async function policyConfigFailure(
  state: TaskRunState,
  ports: TaskRunPorts,
  error: PolicyConfigError,
  reason: string,
): Promise<InfrastructureDispatchResult> {
  await ports.log.write(
    `CONTEXT PACK CONFIG ERROR (infrastructure): task=${state.taskId} config=${error.configFile} reason=${reason}`,
  );
  return {
    kind: "infrastructure",
    stage: "context-pack-config",
    exitCode: POLICY_CONFIG_INVALID_EXIT_CODE,
    detail: `config=${error.configFile}`,
  };
}

/**
 * Repair prompt'ai naudoja fiksuotą „# Repair Task" šabloną be `## Failai` sekcijos, tad
 * `contextPack()` jiems visada meta klaidą. Biudžeto vartai tokiu atveju yra patariamieji
 * (praleidžiami, ne blokuojantys): repair prompt'as jau perėjo preflight/context-pack/budget
 * kaip originalus task'as.
 *
 * Etalono task 872: NORMALAUS (ne repair) dispatch'o context-pack klaida NIEKADA nevirsta tuo
 * pačiu patariamuoju praleidimu — kitaip blogai suformuotas reformulated task'as apeitų
 * biudžeto vartus visiškai.
 *
 * Etalono task 0032: sugadintas policy konfigas yra TREČIA klasė — infrastruktūra, ne per-task
 * human-review: jis liečia kiekvieną eilės task'ą, tad nė vienas iš jų nėra kaltas.
 */
async function buildContextPack(
  state: TaskRunState,
  ports: TaskRunPorts,
  promptFile: string,
  isRepair: boolean,
): Promise<ContextPackOutcome> {
  try {
    return { kind: "ok", pack: await ports.policy.buildContextPack(promptFile) };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    // Konfigo gedimas nėra repair šablono savybė: jis liečia kiekvieną task'ą, tad
    // patariamasis praleidimas čia negalioja net repair dispatch'ui.
    if (isPolicyConfigError(error)) {
      return { kind: "config-error", error, reason };
    }
    if (isRepair) {
      await ports.log.write(
        `BUDGET ENFORCEMENT ADVISORY (context-pack unavailable for repair task): task=${state.taskId} reason=${reason}`,
      );
      return { kind: "advisory-skip" };
    }
    await ports.log.write(
      `BUDGET ENFORCEMENT BLOCKED (context-pack failed for non-repair task): task=${state.taskId} reason=${reason}`,
    );
    return { kind: "blocked", reason };
  }
}

/** Vartų verdiktas PRIEŠ vykdytojo paleidimą: nė vienas jų dar nepalietė nei failų, nei sesijos. */
export type PreDispatchGateResult =
  | { kind: "ok" }
  | Extract<DispatchTaskResult, { kind: "human-review" }>
  | InfrastructureDispatchResult;

/**
 * VISI dispatch'o vartai, kurie sprendžia PRIEŠ vykdytojo paleidimą: `decision.json` validumas,
 * adapterio rolė, context-pack surinkimas ir biudžetas.
 *
 * Atskirti nuo pačios sekos, kad kvietėjas galėtų PATIKIMAI atskirti „vetuota dar nieko
 * nepaleidus" nuo „vykdytojas jau dirbo" — repair kelias tuo remiasi atstatydamas originalų
 * užduoties tekstą (etalono task 0058, „repair-clobber"). Vartai gyvena čia, o ne kvietėjuje,
 * nes jie skaito TĄ PATĮ prompt failą, kuris keliaus vykdytojui.
 */
export async function runPreDispatchGates(
  state: TaskRunState,
  ports: TaskRunPorts,
  request: { promptFile: string; isRepair: boolean },
): Promise<PreDispatchGateResult> {
  const { promptFile, isRepair } = request;

  // Sprendimo būsena pertikrinama ČIA (ne tik preflight/diagnozės skaitymo metu), nes
  // `decision.json` tarp tų skaitymų perrašomas (pvz. diagnozė generuoja repair verdiktą).
  // Nevalidūs metaduomenys neturi pasiekti dispatch'o, kuris kitaip tyliai dispatch'intų su
  // default modeliu vietoje parkavimo į human-review.
  const decisionResult = await ports.state.readDecision(state.taskId);
  if (decisionResult.status === "invalid") {
    return { kind: "human-review", reason: `TASK HUMAN REVIEW: ${state.taskId} corrupted_decision_json=1` };
  }

  // Etalono task 889: loop'as dalijasi kanoniniu adapter routing servisu su rankiniu dispatch'u.
  // Loop'as vykdo tik per claude adapterį, tad task'as, kurio rolė jo neleidžia, parkuojamas.
  try {
    await ports.policy.assertLoopAdapterAllowed(promptFile);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    // Šie vartai skaito `agents.json` PRIEŠ context-pack surinkimą, tad sugadintas konfigas
    // pasiekia juos pirmas. Be šios patikros jis virstų vieno task'o human-review parku, nors
    // liečia kiekvieną eilės task'ą (etalono task 0032). Neleistina ROLĖ (galiojantis
    // konfigas) lieka human-review, kaip ir anksčiau.
    if (isPolicyConfigError(error)) {
      return await policyConfigFailure(state, ports, error, reason);
    }
    return { kind: "human-review", reason: `TASK HUMAN REVIEW: ${state.taskId} adapter_not_allowed=${reason}` };
  }

  const packResult = await buildContextPack(state, ports, promptFile, isRepair);
  if (packResult.kind === "config-error") {
    return await policyConfigFailure(state, ports, packResult.error, packResult.reason);
  }
  if (packResult.kind === "blocked") {
    return { kind: "human-review", reason: `TASK HUMAN REVIEW: ${state.taskId} context_pack_failed=${packResult.reason}` };
  }
  if (packResult.kind === "ok") {
    // 017 (2026-08-25, audito P1-1): vartai tikrina REALIAI dispatch'insimą modelį, ne
    // preflight pasirinkimą — routing'as skaičiuojamas prieš vartus tais pačiais įėjimais
    // kaip claude-dispatch viduje („vetuota prieš paleidimą" kontraktas išlaikytas).
    // Adapterio klaida — garsi ir krenta atgal į decision modelį: senoji (netiksli) patikra
    // geriau nei jokios, o infrastruktūrinė klaida čia neturi parkuoti task'o.
    const decisionModel = decisionResult.decision.selected_model?.trim() || "sonnet";
    let model = decisionModel;
    try {
      const selectedModel = decisionResult.decision.selected_model?.trim();
      model = await ports.policy.resolveDispatchModelClass({
        promptFile,
        taskId: state.taskId,
        phase: isRepair ? "repair" : "implementation",
        ...(selectedModel ? { selectedModel } : {}),
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      await ports.log.write(
        `DISPATCH MODEL GATE FALLBACK: task=${state.taskId} routed model unavailable (${reason}) — enforcing decision model=${decisionModel}`,
      );
    }
    // PC-TOOLBUDGET-03: naudojamas vienintelis `default` tool-budget profilis. `taskId`/`phase`
    // perduodami eksplicitiškai, kad whole-task valdymas nepriklausytų nuo context-pack turinio
    // ir projektuojamas kvietimas būtų priskirtas realiai vykdomai fazei.
    const budgetStatus = await ports.policy.enforceBudget({
      model,
      contextPack: packResult.pack,
      taskId: state.taskId,
      phase: isRepair ? "repair" : "implementation",
    });
    if (!budgetStatus.ok) {
      return {
        kind: "human-review",
        reason: `TASK HUMAN REVIEW: ${state.taskId} budget_enforcement_failed=${budgetStatus.reasons.join("; ")}`,
      };
    }
  }

  return { kind: "ok" };
}

export async function dispatchTask(
  state: TaskRunState,
  ports: TaskRunPorts,
  request: DispatchTaskRequest,
): Promise<DispatchTaskResult> {
  const { promptFile, fromTaskFile, isRepair } = request;

  const gates = await runPreDispatchGates(state, ports, { promptFile, isRepair });
  if (gates.kind !== "ok") {
    return { ...gates, preExecution: true };
  }

  // `--task-id` perduoda tapatybę TIESIOGIAI iš orchestratoriaus (2026-08-11): be jo
  // dispatch tapatybės kandidatą imdavo iš globalaus `decision.json` legacy skaitymo,
  // kuris amžinai blokavo antrą worker slot'ą (o su dviem slot'ais du dispatch'ai skaitytų
  // VIENĄ bendrą decision failą — reali ko-nuomos rizika, ne vien telemetrijos triukšmas).
  const claudeExit = await ports.cli.run(["claude-dispatch", promptFile, "--task-id", state.taskId]);
  await ports.log.write(`CLAUDE RETURNED TO ORCHESTRATOR: task=${state.taskId} exit=${claudeExit}`);
  await ports.policy.logTaskUsageLedger(state.taskId);

  // Infrastruktūra (ne task'as) sugedusi — tęsiant kiti taskai degtų lygiai taip pat.
  // Grąžinama PRIEŠ perkėlimą į `active`, kad abort'as matytų task'ą tame bucket'e,
  // kuriame jis realiai yra.
  if (await ports.failure.isDispatchInfrastructureFailure(claudeExit, state.taskId)) {
    return { kind: "infrastructure", stage: "dispatch", exitCode: claudeExit };
  }

  // Etalono task 0053: dispatch'o ATSISAKYMAS (execution-context gate, biudžeto vartai,
  // sugadintas decision.json) yra fail-fast PRIEŠ paleidimą — jokia sesija nevyko, tad
  // `active` bucket'e nėra ką verifikuoti. Iki tol toks task'as vis tiek keliaudavo į
  // `active` ir per quality-gates + diagnozę, kurie skaitydavo ANKSTESNIO dispatch'o
  // artefaktus, ir baigdavosi atsitiktiniu verdiktu. Naudojimo klaida turi vieną teisingą
  // terminalinį maršrutą: human-review su tikra priežastimi (exit kodu), be papildomo LLM
  // kvietimo.
  if (isUsageErrorExitCode(claudeExit)) {
    return { kind: "human-review", reason: `TASK HUMAN REVIEW: ${state.taskId} dispatch_refused=${claudeExit}` };
  }

  const movedFile = await ports.tasks.move(fromTaskFile, "active", state.taskName);
  state.activeFile = state.remember(movedFile);
  const fingerprint = await ports.tasks.fingerprint(state.activeFile);
   
  state.fingerprint = fingerprint;
  await ports.ledger.recordState(state.taskId, state.taskName, "active", state.activeFile, state.fingerprint);
  await ports.journal.recordCheckpoint({
    actor: "supervisor",
    phase: "post-claude-diagnosis",
    status: "started",
    task_id: state.taskId,
    task_file: state.activeFile,
    log_file: ports.state.logPath("claude-last.log"),
    next_action: "Run quality gates and supervisor diagnosis",
  });
  await ports.log.write(`TASK RETURNED TO ORCHESTRATOR ACTIVE: ${state.taskId}`);
  return { kind: "ok", activeFile: state.activeFile, fingerprint: state.fingerprint };
}
