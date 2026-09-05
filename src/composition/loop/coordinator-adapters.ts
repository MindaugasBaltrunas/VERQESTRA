// Koordinatoriaus portų surišimas, I dalis: žurnalai, savo CLI, gedimų klasifikacija, task
// failai, repair prompt'as, ledger'is ir runtime būsena (manual DI, LAY-2).
//
// Koordinatorius yra vienintelis kelias, kuris VALDO task'o gyvavimo ciklą — jis judina failus
// tarp bucket'ų ir uždaro juos kaip `done`. Todėl kiekvienas šio failo adapteris turi tą pačią
// savybę: jis niekada nespėja. Neperskaitomas sprendimas yra `invalid` (o ne default'ai),
// sugadinta būsena yra `corrupted` (o ne tuščia), o task'o perkėlimas eina per TĄ PAČIĄ
// lock'uojamą saugyklą, kurią naudoja rankinės komandos.
//
// II dalis (git, politika, diagnozės taisyklės, užbaigimas) — `coordinator-execution-adapters`.

import path from "node:path";
import type {
  CliPort,
  DecisionReadResult,
  FailurePort,
  LogPort,
  RepairPromptPort,
  ResumeStateSnapshot,
  RuntimeStatePort,
  StopStatusSnapshot,
  TaskFilePort,
  TaskJournalPort,
  TaskLedgerPort,
} from "../../application/task-execution/run-coordinator-ports.js";
import { clearTaskLedgerEntry } from "../../application/task-execution/task-ledger-service.js";
import {
  activateQueuedTask,
  finishTaskInBucket,
  moveTaskToBucket,
  taskBucketDir,
} from "../../application/task-execution/bucket-transition.js";
import { shouldResetSessionWriteLedger } from "../../application/task-execution/session-write-owners.js";
import { clearSessionWriteLedger } from "../../interfaces/hooks/session-write-ledger.js";
import type { TaskLedgerEntry } from "../../application/task-execution/task-ledger-rules.js";
import { taskFileStem, taskLedgerKey } from "../../domain/tasks/identity.js";
import { decisionOwnership } from "../../domain/tasks/decision-ownership.js";
import { buildTaskStartStatus } from "../../domain/git/rollback-rules.js";

import { isInfrastructureExitCode } from "../../shared/exit-codes.js";
import { WorkflowInfrastructureError } from "../../shared/errors.js";
import { toPrettyJson, tryParseJson } from "../../shared/json.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { gitHead, gitStatusPorcelain } from "../../infrastructure/git/git-client.js";
import { sha256Hex } from "../../shared/hash.js";
import { readTaskRepairPrompt, removeTaskRepairPrompt } from "../../infrastructure/state/task-repair-store.js";
import { recordResumeCheckpoint } from "../../infrastructure/state/resume-checkpoint.js";
import type { AttemptResolutionPort } from "../../infrastructure/state/attempt-resolution.js";
import { createTaskStateStore } from "../../infrastructure/state/task-state-store.js";
import { appendLogLine, readJsonSnapshot } from "./adapters.js";
import { ANALYTICS_SNAPSHOT_STATES } from "../../application/task-execution/task-events-model.js";
import { emitLearningEventsForTaskTransition } from "../../application/learning/learning-emitter.js";
import { updateTokenAnalyticsSnapshot } from "../../application/learning/token-analytics-snapshot.js";
import { taskLedgerStore } from "../runtime/node-adapters.js";
import { readClaudeSessionLog, readOptionalFile } from "../quality/diagnose-adapters.js";
import { run } from "../../infrastructure/process/run-process.js";
import { cliEntryPath } from "../runtime/context.js";

export type CoordinatorAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
  agRoot: string;
  resolution: AttemptResolutionPort;
  /** Savo CLI vykdytojas — koordinatorius kviečia TAS PAČIAS komandas, kurias mato operatorius. */
  runCli(args: string[]): Promise<number>;
  runCliCaptured(args: string[]): Promise<{ code: number; output: string }>;
  /** Cheap finish env overlay; kai nepaduotas, `cheapFinish` portas NEPRIJUNGIAMAS. */
  cheapFinishOverlay?: { consume(): Record<string, string> | undefined; arm(taskId: string): void };
};

export function coordinatorLogPort(runtimeRoot: string): LogPort {
  return { write: (message) => appendLogLine(runtimeRoot, "orchestrator.log", message) };
}

/**
 * Koordinatoriaus CLI portas.
 *
 * Vykdomos TOS PAČIOS komandos, kurias mato operatorius — ne vidinės funkcijos. Tai brangiau
 * (procesas ar bent registro dispatch'as), bet būtent tai garantuoja, kad rankinis
 * `verqestra claude-dispatch …` ir loop'o dispatch'as eina per tuos pačius vartus.
 */
export function coordinatorCliPort(input: CoordinatorAdapterInput): CliPort {
  return {
    run: (args) => input.runCli(args),
    runCaptured: (args) => input.runCliCaptured(args),
  };
}

/** Gedimų klasifikacija: infrastruktūros exit kodai ir dispatch spawn požymiai. */
export function coordinatorFailurePort(runtimeRoot: string): FailurePort {
  return {
    isInfrastructureExit: (code) => isInfrastructureExitCode(code),
    /**
     * Ne kiekvienas ne-nulinis dispatch kodas yra task'o kaltė. `claude-last.log` spawn/ENOENT
     * požymis reiškia, kad modelis NIEKADA nebuvo paleistas — toks bandymas neturi degti kaip
     * nesėkmingas retry, nes task'as dar nė karto nebuvo bandytas.
     */
    isDispatchInfrastructureFailure: async (exitCode) => {
      if (exitCode === 0) return false;
      if (isInfrastructureExitCode(exitCode)) return true;
      // Žurnalas skaitomas GLOBALUS ir be task filtro sąmoningai: spawn gedimas įvyksta
      // PRIEŠ tai, kai procesas apskritai sužino task'o id, tad jo žinutėje jo ir nebus.
      const log = await readOptionalFile(path.join(runtimeRoot, "logs", "claude-last.log"));
      return /spawn \S+ ENOENT|ENOENT|command not found|is not recognized as/i.test(log);
    },
    infrastructureError: (message, options) => new WorkflowInfrastructureError(message, options),
  };
}

/**
 * Task failų portas: keliai, tapatybė, pirštų atspaudai ir perkėlimai.
 *
 * Perkėlimai eina per TĄ PAČIĄ `createTaskStateStore` saugyklą kaip `task-move`/`requeue`:
 * antra, „koordinatoriaus" perkėlimo implementacija reikštų, kad loop'as ir operatorius gali
 * judinti tą patį failą vienu metu be bendro lock'o.
 */
export function coordinatorTaskFilePort(input: CoordinatorAdapterInput): TaskFilePort {
  const store = createTaskStateStore({ agRoot: input.agRoot, runtimeRoot: input.runtimeRoot });

  return {
    // Bucket kelio taisyklė yra VIENA — `bucket-transition.ts`. Iki 2026-08-23 čia gyveno jos
    // pažodinė kopija (`path.join(agRoot, "tasks", bucket)` + inline move/finish/activate),
    // o `activateQueuedTask` application pusėje liko be nė vieno kvietėjo.
    bucketPath: (bucket, taskName) => path.join(taskBucketDir(input.agRoot, bucket), taskName),
    bucketOf: (filePath) => path.basename(path.dirname(filePath)),
    taskIdOf: (filePath) => taskLedgerKey(filePath),
    exists: (filePath) => nodeFsAdapter.exists(filePath),
    // Pirštų atspaudas skaičiuojamas iš BAITŲ: tekstinis skaitymas normalizuotų eilučių galus
    // ir tas pats failas Windows'e bei Linux'e duotų skirtingą atspaudą.
    fingerprint: async (filePath) => sha256Hex(await nodeFsAdapter.readFileBytes(filePath)),
    move: (from, to, taskName, options) =>
      moveTaskToBucket(store, input.agRoot, from, to, taskName, options === undefined ? {} : options),
    finish: (from, to, taskName, cleanupFiles) => finishTaskInBucket(store, input.agRoot, from, to, taskName, cleanupFiles),
    activateQueued: (queuedFile, taskId) => activateQueuedTask(store, input.agRoot, queuedFile, taskId),
    /**
     * Performuluotas task'as PAKEIČIA originalą tik tada, kai jis realiai yra.
     *
     * Trūkstamas performulavimas nėra klaida: preflight'as galėjo jo nesukurti (pvz. task'as
     * jau buvo pakankamai aiškus), ir tada dirbama su originaliu tekstu.
     */
    installReformulatedTask: async (targetFile) => {
      const reformulated = await nodeFsAdapter.readTextFileIfExists(
        path.join(input.runtimeRoot, "supervisor", "reformulated-task.md"),
      );
      if (reformulated === undefined || reformulated.trim() === "") return;
      await nodeFsAdapter.writeTextFile(targetFile, reformulated);
    },
    writeTaskBody: (taskFile, content) => nodeFsAdapter.writeTextFile(taskFile, content),
    readTaskBody: (taskFile) => readOptionalFile(taskFile),
    clearCurrentTaskFile: (expectedFilePath) => store.clearCurrentTaskFile(expectedFilePath),
  };
}

/** Repair prompt'as: task-scoped `vq/state/repair/<id>.md`. */
export function coordinatorRepairPromptPort(runtimeRoot: string): RepairPromptPort {
  return {
    read: (taskId) => readTaskRepairPrompt(runtimeRoot, taskId),
    remove: (taskId) => removeTaskRepairPrompt(runtimeRoot, taskId),
  };
}

/**
 * Task ledger'is: dublikatų aptikimas ir būsenų fiksavimas.
 *
 * `seenBefore` lygina PIRŠTŲ ATSPAUDĄ, ne task id: tas pats numeris eilėje kartojasi tarp kartų,
 * o tas pats turinys — ne. Lyginimas pagal id uždarytų naują, dar nedarytą task'ą kaip matytą.
 */
export function coordinatorLedgerPort(runtimeRoot: string): TaskLedgerPort {
  const store = taskLedgerStore(runtimeRoot);

  return {
    init: async () => {
      if (!(await store.exists())) await store.write({});
    },
    seenBefore: async (taskId, fingerprint) => {
      const entry = (await store.read())[taskId];
      return entry?.fingerprint === fingerprint && entry.state === "done";
    },
    recordState: async (taskId, taskName, state, file, fingerprint) => {
      const ledger = await store.read();
      const entry: TaskLedgerEntry = {
        ...ledger[taskId],
        task_name: taskName,
        state,
        file,
        fingerprint,
        updated_at: new Date().toISOString(),
      };
      await store.write({ ...ledger, [taskId]: entry });
    },
    clearEntry: async (taskId) => {
      await clearTaskLedgerEntry(store, taskId);
    },
  };
}

/** Žurnalas: task įvykiai, fazių gedimai ir resume checkpoint'ai. */
export function coordinatorJournalPort(input: CoordinatorAdapterInput): TaskJournalPort {
  const eventsPath = path.join(input.runtimeRoot, "logs", "task-events.jsonl");

  return {
    recordEvent: async (event) => {
      await nodeFsAdapter.appendTextFile(
        eventsPath,
        `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`,
      );

      // Learning kelias yra best-effort ir NIEKADA negali nutraukti perėjimo įrašymo: emiseris
      // savo try/catch jau turi, bet snapshot'o kvietimas čia yra papildomas — apgaubtas atskirai,
      // kad viena klaida nesustabdytų kitos.
      try {
        await emitLearningEventsForTaskTransition(nodeFsAdapter, input.runtimeRoot, event);
        if (ANALYTICS_SNAPSHOT_STATES.has(event.to_state)) {
          await updateTokenAnalyticsSnapshot(nodeFsAdapter, input.runtimeRoot);
        }
      } catch {
        /* learning maitinimas yra best-effort — niekada neblokuoja task perėjimo */
      }
    },
    /**
     * Fazės gedimas: mašininė eilutė žurnale plius apkarpyta išvestis.
     *
     * Išvestis kerpama SĄMONINGAI: pilnas nepavykusio bėgimo stdout gali būti megabaitai, o
     * žurnalas, kurio niekas nebeatidaro, nustoja būti įrodymu.
     */
    recordPhaseFailure: (taskId, phase, exitCode, output) =>
      appendLogLine(
        input.runtimeRoot,
        "orchestrator.log",
        `PHASE FAILED: task=${taskId} phase=${phase} exit=${exitCode} ${output.trim().slice(0, 2000)}`,
      ),
    recordCheckpoint: (checkpoint) =>
      recordResumeCheckpoint({
        projectRoot: input.projectRoot,
        runtimeRoot: input.runtimeRoot,
        resolution: input.resolution,
        checkpoint,
      }),
  };
}

// `readJsonSnapshot` iškelta į `adapters.ts` (2026-08-24): jos prireikė ir retry guard'ui, o
// antra kopija būtų buvusi tas pats dvigubas atsakymas, kurį šis skaitytojas ir taiso.

/** Runtime būsena: sprendimas, stop statusas, resume, einamasis task'as ir baseline. */
export function coordinatorStatePort(input: CoordinatorAdapterInput): RuntimeStatePort {
  const statePath = (name: string): string => path.join(input.runtimeRoot, "state", name);

  return {
    /**
     * Nevalidus sprendimas grąžina `invalid`, o NE default'us: kvietėjas tada parkuoja task'ą į
     * human-review. Tylus default'as reikštų, kad neperskaitomas supervizoriaus sprendimas
     * virsta „nieko ypatingo" ir task'as vykdomas su išgalvotu verdiktu.
     */
    readDecision: async (taskId): Promise<DecisionReadResult> => {
      const read = await readJsonSnapshot<{ task_id?: string; verdict?: string }>(
        path.join(input.runtimeRoot, "supervisor", "decision.json"),
      );
      if (read.status === "corrupted") return { status: "invalid", cause: "corrupted" };
      const decision = read.value;
      // Svetimo task'o sprendimas irgi yra `invalid`: jis galioja, bet ne šiam task'ui.
      // `cause: "foreign"` neša rastą task_id, kad priežastis operatoriui įvardytų NUOSAVYBĖS,
      // o ne failo turinio gedimą (task 041-a — iki tol abu virsdavo corrupted_decision_json=1).
      //
      // Taisyklė yra ta pati funkcija, kurią kviečia `dispatch-adapters.readSupervisorDecision`
      // (`domain/tasks/decision-ownership`). Nuo 2026-09-05 ji čia GRIEŽTESNĖ dviem taškais:
      // palyginimas nebejautrus raidžių dydžiui, o sprendimas BE `task_id` nebėra „savas".
      // Preflight `task_id` rašo visada, tad jo nebuvimas reiškia ranka redaguotą ar legacy
      // failą — `<missing>` markeryje pasako operatoriui būtent tai, o ne tylų verdiktą.
      const ownership = decisionOwnership({ decisionTaskId: decision.task_id, taskId });
      if (ownership !== "own") {
        return {
          status: "invalid",
          cause: "foreign",
          decisionTaskId: ownership === "missing" ? "<missing>" : (decision.task_id ?? ""),
        };
      }
      return { status: "ok", decision };
    },
    readStopStatus: () => readJsonSnapshot<StopStatusSnapshot>(statePath("claude-stop-status.json")),
    readResumeState: (taskId) =>
      readJsonSnapshot<ResumeStateSnapshot>(statePath(`${taskId}-resume.json`)).then(async (scoped) =>
        scoped.status === "ok" && Object.keys(scoped.value).length > 0
          ? scoped
          : await readJsonSnapshot<ResumeStateSnapshot>(statePath("claude-resume.json")),
      ),
    setCurrentTask: async (taskId, taskFile) => {
      await nodeFsAdapter.writeTextFile(statePath("current-task-id"), `${taskId}\n`);
      await nodeFsAdapter.writeTextFile(statePath("current-task-file"), `${taskFile}\n`);
    },
    /**
     * Per-task baseline: `base_head` yra riba, nuo kurios skaičiuojamas šio bandymo darbo
     * įrodymas. Be jos įrodymų langas lieka tuščias, o tai reiškia, kad task'as niekada
     * neužsidarys kaip `done` be žmogaus — griežtesnė pusė.
     *
     * Įrašo formą sudėlioja `buildTaskStartStatus` (`domain/git/rollback-rules`) — tas pats modulis,
     * kuris jį ir skaito. Inline objekto literalas čia buvo priežastis, dėl kurios iki 2026-08-24
     * trūko `baseline_valid` ir kiekvienas task-scoped rollback buvo blokuotas; sujungimą dabar
     * saugo bendras tipas, ne sutapimas.
     */
    recordTaskStartStatus: async (taskId) => {
      const payload = buildTaskStartStatus({
        taskId,
        baseHead: (await gitHead(input.projectRoot)) ?? "",
        startedAt: new Date().toISOString(),
        gitStatus: await gitStatusPorcelain(input.projectRoot),
      });

      // Per-TASK session-writes ledger'io pradžia (etalono task 1100 + 0049 + 0056). Iki
      // 2026-08-23 čia buvo plikas `writeTextFile("[]")`: (1) BESĄLYGINIS — to paties task'o
      // pakartotinis startas ištrindavo ankstesnio bandymo rašymus, kurių finalinis Stop
      // nebestage'indavo; (2) BE LOCK'O — lenktyniavo su PostToolUse `read → push → rename`,
      // ir pralaimėjęs valymas grąžindavo svetimą įrašą į ką tik išvalytą ledger'į;
      // (3) palikdavo owners sidecar'ą ir KPI žurnalą rodyti į praeito task'o kelius.
      // `clearSessionWriteLedger` visus tris uždaro — o jos pačios kvietėjo iki šiol nebuvo.
      const previousRaw = await nodeFsAdapter.readTextFileIfExists(statePath("task-start-status.json"));
      const previousParsed = previousRaw === undefined ? undefined : tryParseJson<unknown>(previousRaw);
      const previousTaskId =
        previousParsed?.ok && previousParsed.value !== null && typeof previousParsed.value === "object"
          ? (previousParsed.value as { task_id?: unknown }).task_id
          : undefined;
      if (shouldResetSessionWriteLedger(typeof previousTaskId === "string" ? previousTaskId : undefined, taskId)) {
        const cleared = await clearSessionWriteLedger(nodeFsAdapter, statePath("session-writes.json"), [
          statePath("session-file-events.jsonl"),
        ]);
        if (!cleared.locked || cleared.failure) {
          await appendLogLine(
            input.runtimeRoot,
            "orchestrator.log",
            `WARNING: session-writes ledger clear degraded task=${taskId} locked=${cleared.locked} reason=${cleared.failure ?? "lock not acquired"}`,
          );
        }
      } else {
        await appendLogLine(
          input.runtimeRoot,
          "orchestrator.log",
          `SESSION WRITES LEDGER KEPT: same task=${taskId} retry/repair — ledger not cleared`,
        );
      }

      const resolved = await input.resolution.resolveActiveAttempt(taskId);
      if (resolved.ok) {
        // Attempt-first: tas pats payload'as pirma į bandymo namespace'ą; jo nesėkmė yra
        // degradacija į global-only, ne klaida.
        try {
          await resolved.attempt.handle.writeJson("task-start-status", payload);
        } catch {
          await appendLogLine(
            input.runtimeRoot,
            "orchestrator.log",
            `WARNING: task-start-status attempt write failed task=${taskId} — global mirror only`,
          );
        }
      }
      await nodeFsAdapter.writeTextFile(statePath("task-start-status.json"), toPrettyJson(payload));
    },
    /**
     * Vykdytojo sesijos žurnalas ATTEMPT-FIRST, per bendrą `readClaudeSessionLog`
     * (`composition/quality/diagnose-adapters.ts`) — tą pačią logiką naudoja diagnozė ir UI
     * (`dashboard-adapters.ts:160`). Iki 2026-08-26 čia buvo bepaduodamas globalus
     * `claude-last.log` NEPRIKLAUSOMAI nuo `taskId`: kai jį jau būdavo perrašiusi kita sesija,
     * `classifyDispatchWriteOutcome` matydavo svetimą žurnalą ir teisingai grąžindavo
     * `"unknown"` — priežastis liko klaidinga ne todėl, kad taisyklė bloga, o todėl, kad
     * skaitytojas rodė ne tą žurnalą (task 040).
     */
    readClaudeLog: async (taskId) => {
      const { origin, text } = await readClaudeSessionLog(input.runtimeRoot, taskId, input.resolution);
      if (origin !== "attempt") {
        await appendLogLine(
          input.runtimeRoot,
          "orchestrator.log",
          `WRITE ACTIVITY LOG FALLBACK: task=${taskId} origin=${origin} — no attempt-scoped claude-last.log, using legacy mirror`,
        );
      }
      return text;
    },
    logPath: (name) => path.join(input.runtimeRoot, "logs", name),
  };
}

/**
 * Koordinatoriaus CLI vykdytojas — VAIKO PROCESAS su tuo pačiu node ir tuo pačiu CLI įėjimu.
 *
 * Vaikas, o ne funkcijos kvietimas viduje, dėl trijų priežasčių:
 *   1. Fazės (`claude-preflight`, `claude-dispatch`, `claude-diagnose`) keičia proceso cwd ir
 *      env — vykdomos in-process jos tai darytų PO koordinatoriaus kojomis;
 *   2. Fazės exit kodas yra kontraktas (infrastruktūros kodai atskiriami nuo task'o nesėkmės), o
 *      vaiko kodas yra tiesioginis to matavimas;
 *   3. Statinis `cli-main` importas čia sukurtų ciklą registras→pjūvis→registras, kurį
 *      architektūros vartai atmestų.
 *
 * `runCaptured` grąžina SUJUNGTĄ stdout+stderr: diagnozė skaito būtent tekstą, o ne srautą, ir
 * atskyrimas ten nieko neduotų — pusė įrodymų dažnai yra stderr pusėje.
 */
export function cliChildRunner(
  projectRoot: string,
  /**
   * Vienkartinis env priedas sekančiam kvietimui (cheap finish). SUNAUDOJAMAS čia, o ne
   * kvietėjo pusėje: taip lengvata negali nutekėti į antrą dispatch'ą, net jei kvietėjas jos
   * pamirštų nuimti.
   */
  envOverlay?: { consume(): Record<string, string> | undefined },
): {
  runCli(args: string[]): Promise<number>;
  runCliCaptured(args: string[]): Promise<{ code: number; output: string }>;
} {
  const invoke = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const overlay = envOverlay?.consume();
    return run(process.execPath, [cliEntryPath(), ...args], {
      cwd: projectRoot,
      ...(overlay === undefined ? {} : { env: { ...process.env, ...overlay } }),
    });
  };

  return {
    runCli: async (args) => (await invoke(args)).code,
    runCliCaptured: async (args) => {
      const result = await invoke(args);
      return { code: result.code, output: `${result.stdout}${result.stderr}` };
    },
  };
}

export { taskFileStem };
