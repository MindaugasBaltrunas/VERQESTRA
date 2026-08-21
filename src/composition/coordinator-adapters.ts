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
  JsonReadResult,
  LogPort,
  RepairPromptPort,
  ResumeStateSnapshot,
  RuntimeStatePort,
  StopStatusSnapshot,
  TaskFilePort,
  TaskJournalPort,
  TaskLedgerPort,
} from "../application/task-execution/run-coordinator-ports.js";
import { clearTaskLedgerEntry } from "../application/task-execution/task-ledger-service.js";
import type { TaskLedgerEntry } from "../application/task-execution/task-ledger-rules.js";
import { taskFileStem, taskLedgerKey } from "../domain/tasks/identity.js";

import { isInfrastructureExitCode } from "../shared/exit-codes.js";
import { WorkflowInfrastructureError } from "../shared/errors.js";
import { toPrettyJson, tryParseJson } from "../shared/json.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { sha256Hex } from "../shared/hash.js";
import { readTaskRepairPrompt, removeTaskRepairPrompt } from "../infrastructure/state/task-repair-store.js";
import { recordResumeCheckpoint } from "../infrastructure/state/resume-checkpoint.js";
import type { AttemptResolutionPort } from "../infrastructure/state/attempt-resolution.js";
import { createTaskStateStore } from "../infrastructure/state/task-state-store.js";
import { appendLogLine } from "./loop-adapters.js";
import { taskLedgerStore } from "./node-adapters.js";
import { readOptionalFile } from "./diagnose-adapters.js";
import { run } from "../infrastructure/process/run-process.js";
import { cliEntryPath } from "./runtime-context.js";

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
  const bucketDir = (bucket: string): string => path.join(input.agRoot, "tasks", bucket);

  return {
    bucketPath: (bucket, taskName) => path.join(bucketDir(bucket), taskName),
    bucketOf: (filePath) => path.basename(path.dirname(filePath)),
    taskIdOf: (filePath) => taskLedgerKey(filePath),
    exists: (filePath) => nodeFsAdapter.exists(filePath),
    // Pirštų atspaudas skaičiuojamas iš BAITŲ: tekstinis skaitymas normalizuotų eilučių galus
    // ir tas pats failas Windows'e bei Linux'e duotų skirtingą atspaudą.
    fingerprint: async (filePath) => sha256Hex(await nodeFsAdapter.readFileBytes(filePath)),
    move: (from, to, taskName, options) =>
      store.moveTaskState(from, bucketDir(to), taskName, options === undefined ? {} : options),
    finish: (from, to, taskName, cleanupFiles) =>
      store.finishTaskState(from, bucketDir(to), taskName, cleanupFiles),
    activateQueued: (queuedFile, taskId) =>
      store.activateTaskFile(queuedFile, path.join(bucketDir("active"), path.basename(queuedFile)), taskId),
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
    recordEvent: (event) =>
      nodeFsAdapter.appendTextFile(
        eventsPath,
        `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`,
      ),
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

/** Vieno JSON dokumento skaitymas su AIŠKIU „sugadintas" atsakymu (ne tuščia reikšme). */
async function readJsonSnapshot<T>(absolutePath: string): Promise<JsonReadResult<T>> {
  const raw = await nodeFsAdapter.readTextFileIfExists(absolutePath);
  if (raw === undefined || raw.trim() === "") return { status: "ok", value: {} as T };
  const parsed = tryParseJson<T>(raw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
    return { status: "corrupted", error: `unreadable JSON: ${absolutePath}` };
  }
  return { status: "ok", value: parsed.value };
}

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
      if (read.status === "corrupted") return { status: "invalid" };
      const decision = read.value;
      // Svetimo task'o sprendimas irgi yra `invalid`: jis galioja, bet ne šiam task'ui.
      if (decision.task_id !== undefined && decision.task_id.trim() !== "" && decision.task_id !== taskId) {
        return { status: "invalid" };
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
     */
    recordTaskStartStatus: async (taskId) => {
      const { gitHead } = await import("../infrastructure/git/git-client.js");
      const payload = {
        task_id: taskId,
        base_head: (await gitHead(input.projectRoot)) ?? "",
        started_at: new Date().toISOString(),
      };
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
      await nodeFsAdapter.writeTextFile(statePath("session-writes.json"), "[]\n");
    },
    readClaudeLog: () => readOptionalFile(path.join(input.runtimeRoot, "logs", "claude-last.log")),
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
