// `verqestra loop` — visos bangos mechanikos SURIŠIMAS (manual DI, LAY-2).
//
// Čia susitinka viskas, kas buvo migruota atskirai: planuoklis, aprūpinimas, integracija,
// papildymas, dispatch'as, slot'o vykdytojas ir išorinis ciklas. Nė vienas jų nežino apie diską ar
// git — visi jų portai suvedami būtent šiame faile.
//
// Trys sprendimai, kurie čia yra sąmoningi, o ne techniniai:
//   1. `runId` gimsta VIENĄ kartą per paleidimą ir keliauja į kiekvieną įvykį bei checkpoint'ą —
//      be jo dviejų bėgimų pėdsakai susilietų į vieną istoriją;
//   2. in-process kelias yra TAS PATS koordinatorius, kurį kviečia `process-queued-task`: vieno
//      slot'o banga privalo elgtis baitas į baitą taip pat, kaip vykdymas be paralelizmo;
//   3. vaikas paleidžiamas per TĄ PAČIĄ CLI, kurią suka loop'as (`cliEntryPath`) — kitaip
//      izoliuota kopija dirbtų su kito build'o semantika.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRunCoordinator } from "../../application/task-execution/run-coordinator.js";
import { readRunBudget } from "../../application/scheduling/run-budget.js";
import { createWaveScheduler, type ProvisioningStateAccess, type WaveIntegrationIo } from "../../application/scheduling/wave-scheduler.js";
import { createWaveProvisioningCoordinator, type WaveProvisioningCoordinator } from "../../application/scheduling/wave-provisioning.js";
import { createSafeLog } from "../../application/scheduling/safe-telemetry.js";
import { createSlotTaskRunner, buildChildEnvironment, PROCESS_QUEUED_TASK_COMMAND } from "../../application/scheduling/slot-task-runner.js";
import { runLoopCycle, type LoopCyclePorts, type ResumableTask } from "../../application/scheduling/loop-cycle.js";
import { LOOP_BLOCKED_EXIT_CODE } from "../../shared/exit-codes.js";
import { handleEmptyQueue, AUDIT_REPAIR_TASK_CONTENT, type EmptyQueuePorts } from "../../application/scheduling/loop-empty-queue.js";
import { productTreeDirtyEntries, type LoopPreconditionPorts } from "../../application/scheduling/loop-preconditions.js";
import { readLoopControl } from "../../application/scheduling/loop-control-store.js";
import { listWorkerLeases, heartbeatWorkerLease, readWorkerLease, releaseWorkerLease } from "../../application/scheduling/worker-lease-store.js";
import { WAVE_SLOT_LEASE_TTL_MS } from "../../application/scheduling/loop-runtime-config.js";
import { createWaveWorkerRequestReader } from "../../application/scheduling/wave-worker-request.js";
import { readWorkerRequest } from "../../application/scheduling/worker-request-store.js";
import { selectNextResumableTask, type TaskSelectionPorts } from "../../application/task-execution/task-selection.js";
import { LOOP_HEARTBEAT_TTL_MS } from "../../domain/scheduling/loop-runtime.js";
import {
  readLoopRuntimeRecord,
  releaseLoopRuntimeRecord,
  writeLoopRuntimeRecord,
} from "../../interfaces/hooks/loop-runtime-store.js";
import { loopPidFile } from "../../interfaces/http/loop-lifecycle.js";
import { loopRuntimePorts } from "../ui/lifecycle-adapters.js";
import { importTaskGraphFromMarkdown } from "../../application/task-execution/task-graph-import.js";
import { reclaimEvidencelessSynthesizedTasks, reclaimExternalInputNodes } from "../../application/architecture/wave-reclaim.js";
import type { WaveDispatchSlot } from "../../application/scheduling/wave-dispatch-model.js";
import type { SlotLeaseMutation } from "../../application/scheduling/slot-task-runner.js";
import { readTaskGraphSnapshot, writeTaskGraphSnapshot } from "../../infrastructure/persistence/task-graph-store.js";
import { readWaveSnapshot, writeWaveSnapshot } from "../../infrastructure/state/wave-snapshot-store.js";
import { recordWaveEvent } from "../../infrastructure/state/wave-events.js";
import { readResumeCheckpoint, recordResumeCheckpoint } from "../../infrastructure/state/resume-checkpoint.js";
import { ensureWorktreeRuntime, PRODUCT_INSTALL_TIMEOUT_MS } from "../../infrastructure/git/worktrees/worktree-runtime.js";
import { reapOrphanWorktrees } from "../../infrastructure/git/worktrees/orphan-worktree-reaper.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { run } from "../../infrastructure/process/run-process.js";
import { childExitSlotLogFileName, formatChildExitDiagnostics } from "./child-exit-diagnostics.js";
import { activeAttemptResolution } from "../../infrastructure/state/active-attempt.js";
import { reapDeadLeases, schedulingFs } from "./adapters.js";
import { architectureWavePorts } from "../quality/architecture-adapters.js";
import { cliEntryPath, type RuntimeRoots } from "../runtime/context.js";
import { createWaveIntegrationAdapters } from "./wave-integration-adapters.js";
import { taskRunPorts } from "./coordinator-execution-adapters.js";
import { cliChildRunner } from "./coordinator-adapters.js";
import { preservedWorkReviewPort } from "./preserved-work-adapters.js";
import { createTaskStateStore } from "../../infrastructure/state/task-state-store.js";
import { createCheapFinishEnvOverlay } from "../quality/cheap-finish-adapters.js";
import {
  ledgerDuplicate,
  locateTaskBucket,
  readQueueSchedulableTasks,
  taskHasAcceptedWork,
  waveWorktreePort,
  type WaveInputAdapterDeps,
} from "./wave-scheduler-adapters.js";

/** Sistemos remonto užduoties failas — jis eina savo keliu, ne per įprastą tęsimą. */
const AUDIT_REPAIR_TASK_FILE = "claude-audit-repair.md";

/**
 * Vaiko exit diagnostikos uodega, papildomai append'inama į `vq/logs/slots/<worker>-<task>-a<attempt>.log`
 * (080-a-02): `deps.log` gyvena `orchestrator.log`, kuris rotuojamas, tad tas pats įrašas
 * papildomai lieka faile, kurio gyvavimas nepriklauso nuo rotacijos. Rašymo klaida NIEKADA
 * nenutraukia slot'o vykdymo — tik `deps.log` eilutė, kaip ir kitos šio failo geros nesėkmės.
 */
export async function appendChildExitSlotLog(
  ports: { fs: { appendTextFile: (absolutePath: string, text: string) => Promise<void> }; log: (message: string) => Promise<void> },
  runtimeRoot: string,
  input: { workerId: string; taskId: string; attemptId?: string },
  diagnosticsText: string,
): Promise<void> {
  const absolutePath = path.join(runtimeRoot, "logs", "slots", childExitSlotLogFileName(input));
  try {
    await ports.fs.appendTextFile(absolutePath, `${diagnosticsText}\n`);
  } catch (error) {
    await ports.log(
      `WAVE SLOT CHILD EXIT LOG APPEND FAILED: slot=${input.workerId} task=${input.taskId} error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type LoopCommandDeps = {
  roots: RuntimeRoots;
  log: (message: string) => Promise<void>;
  out: (message: string) => void;
  emptyQueue: EmptyQueuePorts;
  preconditions: LoopPreconditionPorts;
  taskSelection: TaskSelectionPorts;
  /** Stop vėliavos suvartojimas (UI kelias). */
  consumeStopRequest: () => Promise<boolean>;
  /** Nutrūkusio task'o tęsimas; `true` = pavyko. */
  resumeTask: (task: ResumableTask) => Promise<boolean>;
  /** Nepavykusio kokybės audito remonto užduoties vykdymas. */
  processAuditRepairTask: (content: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
};

export function buildLoopCyclePorts(deps: LoopCommandDeps): LoopCyclePorts {
  const { projectRoot, agRoot, runtimeRoot } = deps.roots;
  const runId = randomUUID();
  const now = (): string => new Date().toISOString();
  // Įrodymų skaitymas NIEKADA nekuria namespace'o: planuoklis tik klausia, ar darbas priimtas.
  const evidenceResolution = activeAttemptResolution({ projectRoot, runtimeRoot });
  const inputs: WaveInputAdapterDeps = { projectRoot, agRoot, runtimeRoot, resolution: evidenceResolution };
  const leaseStore = { fs: schedulingFs };
  const readWorkerLeases = (): Promise<Awaited<ReturnType<typeof listWorkerLeases>>> => listWorkerLeases(schedulingFs, projectRoot);
  const absolutePath = (relativeFile: string): string => path.join(projectRoot, relativeFile);
  const stateDir = path.join(runtimeRoot, "state");
  const cheapFinishOverlay = createCheapFinishEnvOverlay();

  // Aprūpinimas gauna PLANUOKLIO būseną (grafą ir tai, kas dirba) per fabriką: konstantos čia
  // reikštų aklą aprūpinimą — be grafo write-set'as tuščias, o be „kas dirba" tas pats task'as
  // gautų antrą lease'ą.
  const provisioning = (access: ProvisioningStateAccess): WaveProvisioningCoordinator =>
    createWaveProvisioningCoordinator({
      workspaceRoot: projectRoot,
      runId,
      // Proceso tapatybė paduodama, ne skaitoma application viduje.
      ownerId: `loop-${process.pid}`,
      leaseStore,
      worktree: waveWorktreePort({ projectRoot, runtimeRoot }),
      now,
      // Aprūpinimas yra ANTRAS koordinatorius, surišamas ne planuoklyje, tad jis turi gauti tą
      // patį saugų žurnalą (2026-08-23): iki tol jo `deps.log` buvo neapsaugotas, ir žurnalo
      // klaida būtų nutraukusi slot'o aprūpinimą.
      log: createSafeLog(deps.log),
      ...access,
    });

  const integrationAdapters = createWaveIntegrationAdapters({
    projectRoot,
    agRoot,
    taskStore: createTaskStateStore({ runtimeRoot, agRoot }),
    leaseStore,
    readWorkerLeases,
  });
  const integration: WaveIntegrationIo = integrationAdapters;

  const scheduler = createWaveScheduler({
    projectRoot,
    runId,
    now,
    log: deps.log,
    absolutePath,
    readTasks: () => readQueueSchedulableTasks(inputs),
    locateTask: (taskId) => locateTaskBucket(inputs, taskId),
    hasAcceptedWork: (taskId) => taskHasAcceptedWork(inputs, taskId),
    // Planuokliui reikia tik pjūvio; pilnas checkpoint'as neša laukus, kurių sprendimas nenaudoja.
    readCheckpoint: async () => {
      const checkpoint = await readResumeCheckpoint(runtimeRoot, "claude");
      return checkpoint === undefined
        ? undefined
        : {
            status: checkpoint.status,
            ...(checkpoint.task_id === undefined ? {} : { task_id: checkpoint.task_id }),
            ...(checkpoint.graph_hash === undefined ? {} : { graph_hash: checkpoint.graph_hash }),
            ...(checkpoint.attempt_id === undefined ? {} : { attempt_id: checkpoint.attempt_id }),
            updated_at: checkpoint.updated_at,
          };
    },
    readSnapshot: () => readWaveSnapshot(stateDir),
    writeSnapshot: async (snapshot) => {
      await writeWaveSnapshot(stateDir, snapshot);
    },
    recordEvent: (event) => recordWaveEvent(runtimeRoot, event),
    recordCheckpoint: (checkpoint) => recordResumeCheckpoint({ projectRoot, runtimeRoot, checkpoint }),
    importGraph: () =>
      importTaskGraphFromMarkdown({
        listTasksInBucket: async (bucket) => {
          const dir = path.join(agRoot, "tasks", bucket);
          const names = (await nodeFsAdapter.listDirectoryIfExists(dir)) ?? [];
          const entries: { file: string; text: string }[] = [];
          for (const name of names.filter((entry) => entry.endsWith(".md"))) {
            const text = await nodeFsAdapter.readTextFileIfExists(path.join(dir, name));
            if (text !== undefined) entries.push({ file: `AG/tasks/${bucket}/${name}`, text });
          }
          return entries;
        },
      }),
    writeGraphSnapshot: async (graph) => {
      await writeTaskGraphSnapshot(graph, runtimeRoot, { source: "markdown:queue", generatedAt: now() });
    },
    readGraphSnapshot: async () => {
      const stored = await readTaskGraphSnapshot(runtimeRoot);
      return stored.ok ? { ok: true, graph: stored.graph } : { ok: false, reason: stored.reason, errors: stored.errors };
    },
    // Run lygio biudžetas: riba yra NEPRIVALOMAS `maxRunBillableTokens` raktas
    // `vq/config/token-budget.json` faile. Jos nesant grąžinama `undefined` — tiksliai ta
    // elgsena, kuri buvo iki šiol. Esamos `tool-budget` ribos čia netiktų: jos yra per-task, ir
    // vieno task'o likutis taptų visos eilės riba.
    readySetBudget: () =>
      readRunBudget({
        readBudgetConfig: () => nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "config", "token-budget.json")),
        readUsageLog: () => nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "token-usage.jsonl")),
      }),
    // Patvirtinimai: veikiantis kanalas yra `HUMAN-REVIEW-APPROVED:` žyma task'o faile —
    // `task-graph-import` iš jos nustato `TaskNode.approved`. Šis run-scoped sąrašas yra ANTRAS
    // kanalas tam pačiam sprendimui; jis lieka tuščias sąmoningai, nes du patvirtinimo keliai,
    // nežinantys vienas apie kitą, yra blogiau nei vienas.
    approvals: () => [],
    requestedWorkers: createWaveWorkerRequestReader({
      readRequest: async () => {
        const state = await readWorkerRequest({ fs: schedulingFs }, stateDir);
        return { requested: state.requested, ...(state.invalid === undefined ? {} : { invalid: state.invalid }) };
      },
      readControl: () => readLoopControl({ fs: schedulingFs }, stateDir),
      log: deps.log,
    }),
    ledgerDuplicate: (taskId, absoluteTaskFile) => ledgerDuplicate(inputs, taskId, absoluteTaskFile),
    integration,
    provisioning,
    readWorkerLeases,
  });

  const runSlotTask = createSlotTaskRunner({
    log: deps.log,
    // Vieno slot'o kelias — TAS PATS koordinatorius, kurį kviečia `process-queued-task`.
    runInProcess: (absoluteFile) =>
      createRunCoordinator(
        taskRunPorts({
          projectRoot,
          runtimeRoot,
          agRoot,
          // In-process kelias VYKDO task'ą — jam namespace'as kuriamas.
          resolution: activeAttemptResolution({ projectRoot, runtimeRoot, create: true }),
          // Overlay gyvena VIENAS visam paleidimui: cheap finish yra vienkartinė išimtis, ir du
          // egzemplioriai reikštų dvi nepriklausomas „vienkartines" teises.
          cheapFinishOverlay,
          ...cliChildRunner(projectRoot, cheapFinishOverlay),
        }),
        { preservedWorkReview: preservedWorkReviewPort({ projectRoot }) },
      ).start(absoluteFile),
    runChild: async (slot, worktreeAbs) => {
      // Task failas perduodamas RELIATYVUS: vaikas jį išsprendžia prieš savo darbo katalogą, tad
      // jokio kelių vertimo tarp medžių čia nereikia.
      const startedAt = Date.now();
      const result = await run(process.execPath, [cliEntryPath(), PROCESS_QUEUED_TASK_COMMAND, slot.file], {
        cwd: worktreeAbs,
        env: buildChildEnvironment(deps.env ?? process.env, "CLAUDE_PROJECT_DIR", worktreeAbs, slot.attempt_ref),
      });
      if (result.code !== 0) {
        // Vaiko lūžis be pėdsako yra nediagnozuojamas: worktree vaiko stderr/stdout niekur kitur
        // nepatenka (jo paties vq/logs miršta kartu su procesu ankstyvo lūžio atveju), tad
        // diagnostika log'inama ČIA — vienintelėje vietoje, kuri išgyvena vaiką. Ji VISADA palieka
        // exit kontekstą ir bent vieną grep'inamą eilutę, net kai vaikas nieko neparašė.
        const diagnostics = formatChildExitDiagnostics({
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - startedAt,
          workerId: slot.worker_id,
          taskId: slot.task_id,
        });
        await deps.log(diagnostics);
        // `deps.log` (orchestrator.log) rotuojasi; ta pati diagnostika ANTRĄ kartą lieka
        // per-slot faile, kurio gyvavimas nuo rotacijos nepriklauso (080-a-02).
        await appendChildExitSlotLog(
          { fs: nodeFsAdapter, log: deps.log },
          runtimeRoot,
          { workerId: slot.worker_id, taskId: slot.task_id, ...(slot.attempt_ref === undefined ? {} : { attemptId: slot.attempt_ref.attemptId }) },
          diagnostics,
        );
      }
      return result.code === 0;
    },
    resolveWorktree: (worktreePath) => path.resolve(projectRoot, worktreePath),
    readLease: (workerId) => readWorkerLease(schedulingFs, projectRoot, workerId),
    heartbeat: async (claim, workerId): Promise<SlotLeaseMutation> => {
      const renewed = await heartbeatWorkerLease({ deps: leaseStore, projectRoot, claim, workerId, ttlMs: WAVE_SLOT_LEASE_TTL_MS });
      return renewed.status === "ok" ? { status: "ok" } : { status: "denied", reason: renewed.authority.reason };
    },
    release: async (claim, workerId): Promise<SlotLeaseMutation> => {
      const released = await releaseWorkerLease({ deps: leaseStore, projectRoot, claim, workerId });
      return released.status === "ok" ? { status: "ok" } : { status: "denied", reason: released.authority.reason };
    },
    prepareWorktree: (worktreeAbs) =>
      ensureWorktreeRuntime({
        projectRoot,
        worktreeAbs,
        layout: {
          distDir: "dist",
          nodeModulesDir: "node_modules",
          configFiles: [path.relative(projectRoot, path.join(runtimeRoot, "config", "local.env")).split(path.sep).join("/")],
          // VISAS runtime konfigų katalogas, ne po failą: vaikas kopijoje be `tool-budget.json`
          // (ir kitų policy failų) lūžta iškart po delegavimo — GeoGravity 2026-08-28, ta pati
          // pamoka kaip benchmark-loop-cell 2026-08-22.
          configDirs: [path.relative(projectRoot, path.join(runtimeRoot, "config")).split(path.sep).join("/")],
          optionalJunctions: [],
        },
        log: deps.log,
        // Laikmatis imamas iš KONSTANTOS, o ne perrašomas skaičiumi (2026-08-24 auditas):
        // `PRODUCT_INSTALL_TIMEOUT_MS` gyveno šalia install'o aprašo su ta pačia reikšme, bet be
        // kvietėjo, tad tas pats stabdiklis egzistavo dviem kopijom. Elgesys nesikeičia — keičiasi
        // tai, kad pakėlus reikšmę vienoje vietoje ji nebelieka sena kitoje.
        runProductInstall: (request) =>
          run(request.command, request.args, { cwd: request.cwd, timeoutMs: PRODUCT_INSTALL_TIMEOUT_MS }).then(
            (result) => result.code,
          ),
      }),
  });

  return {
    scheduler,
    absolutePath,
    log: deps.log,
    out: deps.out,
    recordEvent: (event) => recordWaveEvent(runtimeRoot, event),
    reapDeadLeases: () => reapDeadLeases(projectRoot, new Date()),
    reapOrphanWorktrees: async () =>
      await reapOrphanWorktrees({ projectRoot, runtimeRoot, agRoot, leases: await readWorkerLeases() }),
    reclaimQueue: async () => {
      // Eilės valymas prieš imant darbą: išgalvoti mazgai ir be įrodymų sintezuoti task'ai.
      // Be grafo tai švarus no-op, tad klaida čia nėra vartai — ji tik prarastų eilutę.
      const lines: string[] = [];
      const wavePorts = architectureWavePorts(projectRoot);
      const external = await reclaimExternalInputNodes(wavePorts, projectRoot);
      if (external.nodes.length > 0) lines.push(`ARCHITECTURE EXTERNAL INPUT NODES RECLAIMED: ${external.nodes.join(", ")}`);
      const evidenceless = await reclaimEvidencelessSynthesizedTasks(wavePorts, projectRoot);
      if (evidenceless.nodes.length > 0) {
        lines.push(`ARCHITECTURE EVIDENCE-LESS TASKS RECLAIMED: ${evidenceless.nodes.join(", ")}`);
      }
      return lines;
    },
    consumeStopRequest: deps.consumeStopRequest,
    readLoopControl: () => readLoopControl({ fs: schedulingFs }, stateDir),
    productTreeDirtyEntries: () => productTreeDirtyEntries(deps.preconditions, projectRoot),
    selectNextResumableTask: async () => {
      const found = await selectNextResumableTask(agRoot, deps.taskSelection);
      return found === undefined ? undefined : { bucket: found.bucket, file: found.file };
    },
    resumeTask: deps.resumeTask,
    isAuditRepairTask: (task) => task.bucket === "error" && path.basename(task.file) === AUDIT_REPAIR_TASK_FILE,
    processAuditRepairTask: () => deps.processAuditRepairTask(AUDIT_REPAIR_TASK_CONTENT),
    handleEmptyQueue: (bootstrapAttempted) => handleEmptyQueue(deps.emptyQueue, projectRoot, bootstrapAttempted),
    runSlotTask: (slot: WaveDispatchSlot) => runSlotTask(slot),
  };
}

/**
 * `verqestra loop` kūnas: portų suvedimas + ciklas.
 *
 * EXIT KONTRAKTAS (operatoriaus sprendimas 2026-08-23; anksčiau buvo besąlyginis `0`):
 *
 *   `0` — loop'as padarė, ko prašytas: eilė ištuštinta arba operatoriaus „stop" įvykdytas;
 *   `1` — loop'as sustojo PALIKĘS darbą ir laukia žmogaus: banga išseko (ciklas, laukiantis
 *         blokatorius, neduotas patvirtinimas), užterštas produkto medis arba nedispatch'intas
 *         nė vienas slot'as.
 *
 * Kodėl `1`, o ne nauja reikšmė `shared/exit-codes` lentelėje: `verqestra loop-guard` tą PATĮ
 * klausimą jau atsako `0 = saugu / 1 = blokuota`, tad antra konvencija tam pačiam klausimui būtų
 * blogesnė už bendrinį kodą. `classifyExitCode(1)` = `task_failure` — sąžininga: bėgimas savo
 * darbo nebaigė. Priežastis lieka žurnale ir stdout; exit kodas neša tik dvejetainį atsakymą.
 *
 * KAS LŪŽTA: skriptai, kurie `verqestra loop` gatino pagal `$?`, blokuotą sustojimą nuo šiol
 * matys kaip nesėkmę. Repo viduje tokių nėra (patikrinta) — visi vartotojai išoriniai.
 */
/**
 * Kaip dažnai ciklas patvirtina, kad gyvas. Penktadalis TTL (`LOOP_HEARTBEAT_TTL_MS` = 5 min):
 * vienas praleistas taktas dar nepaverčia gyvo proceso „sustojusiu", o keturi iš eilės — jau taip.
 */
const LOOP_HEARTBEAT_REFRESH_MS = LOOP_HEARTBEAT_TTL_MS / 5;

/**
 * Ciklo proceso GYVYBĖS ŽYMĖ — trūkstamas `loop-lifecycle.ts` pažado antras galas.
 *
 * Ten, iškart po spawn'o, parašytas komentaras sako: „Pradinis įrašas su heartbeat'u; toliau jį
 * atnaujina PATS loop'as". To rašytojo nebuvo. `writeLoopRuntimeRecord` produkcijoje buvo
 * kviečiamas lygiai du kartus — po spawn'o ir sesijos starte — tad `heartbeat_at` amžinai lygdavosi
 * `started_at`.
 *
 * Ką tai reiškė praktiškai (išmatuota 2026-08-24 ir 2026-08-25): `loopRuntimeIsAlive` reikalauja
 * PID + ŠVIEŽIO heartbeat, tad ciklas UI'ui atrodydavo gyvas TIK pirmąsias 5 minutes. Po jų —
 * „sustojęs", nors suko užduotis (matuota 11 min ir 38 min). Blogiausia pasekmė ne rodmuo:
 * atrakintas „Paleisti" mygtukas, o `startLoop` prie negyvo įrašo ištrina jį kaip pasenusį ir
 * paleidžia ANTRĄ orkestratorių ant tos pačios eilės — dviguba tos pačios užduoties aktyvacija,
 * `EBUSY` ant bendrų žurnalų ir nužudyti nesusiję task'ai.
 *
 * Atlaisvinimas pabaigoje yra to paties kontrakto pusė: `domain/scheduling/loop-runtime` aprašo,
 * kad „švariai sustojęs loop'as PATS ištrina savo įrašą", ir kad būtent dėl to įrašo NEBUVIMAS
 * savo įrašą valdančiam procesui reiškia „sustojęs". Be trynimo UI po tvarkingo sustojimo dar
 * TTL laiką rodytų gyvą ciklą.
 *
 * Nė viena heartbeat klaida nestabdo ciklo: gyvybės žymė yra rodmuo, o ne darbo sąlyga.
 */
async function startLoopRuntimeHeartbeat(deps: LoopCommandDeps): Promise<() => Promise<void>> {
  const pidFile = loopPidFile(path.join(deps.roots.runtimeRoot, "state"));
  const ownPid = process.pid;

  const beat = async (): Promise<void> => {
    try {
      // Perskaitoma KIEKVIENĄ taktą: `started_at` ir supervizoriaus būsena priklauso ne mums, o
      // įrašui — perrašius juos iš atminties, watchdog'o skaitiklis grįžtų atgal.
      const current = await readLoopRuntimeRecord(loopRuntimePorts, pidFile);
      const mine = current?.pid === ownPid ? current : undefined;
      await writeLoopRuntimeRecord(loopRuntimePorts, pidFile, ownPid, {
        ...(mine?.started_at === undefined ? {} : { startedAt: mine.started_at }),
        ...(mine?.supervisor === undefined ? {} : { supervisor: mine.supervisor }),
      });
    } catch (error) {
      await deps.log(`WARNING: loop heartbeat neužrašytas pid=${ownPid} — ${String(error)}`);
    }
  };

  await beat();
  const timer = setInterval(() => void beat(), LOOP_HEARTBEAT_REFRESH_MS);
  // `unref`: taimeris niekada nelaiko proceso gyvo ilgiau už patį ciklą.
  timer.unref?.();

  return async () => {
    clearInterval(timer);
    try {
      await releaseLoopRuntimeRecord(loopRuntimePorts, pidFile, ownPid);
    } catch (error) {
      await deps.log(`WARNING: loop įrašas neatlaisvintas pid=${ownPid} — ${String(error)}`);
    }
  };
}

export async function runLoopCommand(deps: LoopCommandDeps): Promise<number> {
  const ports = buildLoopCyclePorts(deps);
  const stopHeartbeat = await startLoopRuntimeHeartbeat(deps);
  try {
    await ports.scheduler.recoverFromCrash();
    const outcome = await runLoopCycle(ports);
    return outcome.kind === "blocked" ? LOOP_BLOCKED_EXIT_CODE : 0;
  } finally {
    await stopHeartbeat();
  }
}
