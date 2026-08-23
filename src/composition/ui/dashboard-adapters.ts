// `/api/dashboard` portų surišimas (manual DI, LAY-2).
//
// `interfaces/http/ui-dashboard-view` yra GRYNAS: jis žino, KOKIE šaltiniai sudaro snapshot'ą ir
// kaip jie virsta wire forma, bet nė vieno jų neskaito. Visi skaitymai sueina čia.
//
// Bendra laikysena ta pati kaip `router-adapters`: dashboard'as yra DIAGNOSTIKOS paviršius, tad
// kiekvienas šaltinis gniūžta atskirai. Vienintelis šalutinis efektas — `ensureRuntimeDirs`, ir
// jis idempotentinis: dashboard'as bandymų nekuria ir vėliavų nesuvartoja.

import path from "node:path";
import { readLoopControl } from "../../application/scheduling/loop-control-store.js";
import { readWorkerRequest } from "../../application/scheduling/worker-request-store.js";
import { listWorkerLeases } from "../../application/scheduling/worker-lease-store.js";
import { waveSnapshotSchema } from "../../application/scheduling/wave-snapshot.js";
import { loadUiControlPlaneData } from "../../interfaces/ui-model/control-plane-model.js";
import type {
  DashboardClaudeLogStamp,
  DashboardStopEvidence,
  DashboardViewPorts,
  DashboardWaveSnapshot,
  UiProcessState,
} from "../../interfaces/http/ui-dashboard-view.js";
import type { WorkflowBucketView } from "../../interfaces/http/workflow-buckets.js";
import type { LoopSlotLeaseView } from "../../interfaces/ui-model/loop-slot-model.js";
import { classifyLoopRuntime } from "../../domain/scheduling/loop-runtime.js";
import { inspectLoopRuntimeRecord } from "../../interfaces/hooks/loop-runtime-store.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { isProcessAlive } from "../../infrastructure/process/process-tree.js";
import { attemptLogPath } from "../../infrastructure/runtime-paths.js";
import { activeAttemptResolution } from "../../infrastructure/state/active-attempt.js";
import { ensureRuntimeDirs } from "../../infrastructure/state/runtime-dirs.js";
import { readStopEvidence } from "../../infrastructure/state/stop-evidence.js";
import { readWaveSnapshot } from "../../infrastructure/state/wave-snapshot-store.js";
import { learningFs } from "../runtime/node-adapters.js";
import { schedulingFs } from "../loop/adapters.js";
import { loopRuntimePorts } from "./lifecycle-adapters.js";

/** Claude srauto kanalas bandymo viduje — tas pats vardas kaip globaliame veidrodyje. */
const CLAUDE_LOG_CHANNEL = "claude-last";

/** Control-plane FS pjūvis: architektūros būsena, learning atmintis, politikos ir katalogai. */
const controlPlaneFs = {
  ...learningFs,
  exists: (absolutePath: string): Promise<boolean> => nodeFsAdapter.exists(absolutePath),
  listFiles: (absoluteDir: string): Promise<string[]> => nodeFsAdapter.listFiles(absoluteDir),
};

export type DashboardAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
  agRoot: string;
  /**
   * Bucket'ų sąrašas paduodamas IŠ IŠORĖS: tuos pačius portus naudoja `/api/tasks` maršrutas, o
   * antra jų kopija čia reikštų du skirtingus atsakymus apie tą pačią eilę.
   */
  loadWorkflowBuckets(): Promise<WorkflowBucketView[]>;
  logError(message: string): void;
};

/**
 * Failo antspaudas. Dydis atsako „ar failas apskritai yra", mtime — „kada paskutinį kartą kas
 * nors rašė". Nesamas failas grąžina tuščią objektą, ne klaidą.
 */
async function fileStamp(absolutePath: string): Promise<{ updatedAt?: string; bytes?: number }> {
  const [bytes, mtimeMs] = await Promise.all([
    nodeFsAdapter.fileSizeBytes(absolutePath),
    nodeFsAdapter.fileMtimeMs(absolutePath),
  ]);
  return {
    ...(bytes === undefined ? {} : { bytes }),
    ...(mtimeMs === undefined ? {} : { updatedAt: new Date(mtimeMs).toISOString() }),
  };
}

/**
 * Bangos snapshot'as, PATIKRINTAS schema.
 *
 * Neparsinamas ar netinkamos formos failas yra `undefined` („plano dar nėra"), o ne dalinis
 * objektas: pusė snapshot'o slot'ų valdikliui blogiau nei jo nebuvimas, nes atrodytų kaip
 * tikras planas.
 */
async function readDashboardWaveSnapshot(stateDir: string): Promise<DashboardWaveSnapshot | undefined> {
  const raw = await readWaveSnapshot<Record<string, unknown>>(stateDir);
  if (raw === undefined) return undefined;
  const validated = waveSnapshotSchema.safeParse(raw);
  if (!validated.success) return undefined;
  const snapshot = validated.data;
  return {
    ...(snapshot.worker_pool === undefined ? {} : { worker_pool: snapshot.worker_pool }),
    tasks: snapshot.tasks.map((task) => ({ task_id: task.task_id, state: task.state })),
    live_slots: snapshot.live_slots.map((slot) => ({
      worker_id: slot.worker_id,
      task_id: slot.task_id,
      attempt: slot.attempt,
      started_at: slot.started_at,
      worktree_path: slot.worktree_path,
    })),
  };
}

/**
 * Proceso būsena iš PID/runtime įrašo.
 *
 * `selfRegistering` skirtumas yra ne detalė, o mygtuko elgesys: savo įrašą valdančiam loop'ui
 * įrašo NEBUVIMAS reiškia „sustojęs" (kitaip po kiekvieno švaraus sustojimo „Paleisti ciklą"
 * liktų negyvas), o pasyviam PID failui be rašytojo nebuvimas nieko neįrodo ir lieka `unknown`.
 */
async function inspectProcess(pidFile: string, options: { selfRegistering: boolean }): Promise<UiProcessState> {
  const inspection = await inspectLoopRuntimeRecord(loopRuntimePorts, pidFile);
  const status = classifyLoopRuntime({
    inspection,
    processIsAlive: (pid) => isProcessAlive(pid),
    selfRegistering: options.selfRegistering,
  });
  if (inspection.state !== "ok") {
    const name = path.basename(pidFile);
    return { status, detail: inspection.state === "absent" ? `${name} not recorded` : `${name} unreadable` };
  }
  return { pid: inspection.record.pid, status };
}

export function dashboardViewPorts(input: DashboardAdapterInput): DashboardViewPorts {
  const { projectRoot, runtimeRoot, agRoot } = input;
  const stateDir = path.join(runtimeRoot, "state");
  // `create: false` — dashboard'as bandymo namespace'o NIEKADA nesukuria; jis tik stebi.
  const resolution = activeAttemptResolution({ projectRoot, runtimeRoot, create: false });

  return {
    ensureDirs: () => ensureRuntimeDirs(agRoot, runtimeRoot),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    fileExists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
    fileStamp,
    loadWorkflowBuckets: () => input.loadWorkflowBuckets(),
    loadControlPlane: () => loadUiControlPlaneData({ fs: controlPlaneFs }, { projectRoot, runtimeRoot }),
    readWorkerRequest: () => readWorkerRequest({ fs: schedulingFs, env: (name) => process.env[name] }, stateDir),
    readLoopControl: () => readLoopControl({ fs: schedulingFs }, stateDir),
    readWaveSnapshot: () => readDashboardWaveSnapshot(stateDir),

    async listWorkerLeases(): Promise<readonly LoopSlotLeaseView[]> {
      const leases = await listWorkerLeases(schedulingFs, projectRoot);
      return leases.map((lease) => ({
        worker_id: lease.worker_id,
        task_id: lease.task_id,
        attempt: lease.attempt,
        status: lease.status,
      }));
    },

    async readStopEvidence(taskId: string): Promise<DashboardStopEvidence> {
      const evidence = await readStopEvidence({ runtimeRoot, resolution, taskId });
      for (const warning of evidence.warnings) input.logError(`[ui] ${warning}`);
      return { record: evidence.record, origin: evidence.origin, corrupted: evidence.corrupted };
    },

    /**
     * Claude sesijos log'o antspaudas ATTEMPT-FIRST. Kilmė grąžinama kartu su antspaudu, nes
     * operatoriui tai skirtingi faktai: `attempt` yra šio bandymo žurnalas, `legacy` — paskutinis
     * bet kurios sesijos, ir antruoju atveju jis gali priklausyti visai kitam task'ui.
     */
    async readClaudeLogStamp(taskId: string): Promise<DashboardClaudeLogStamp> {
      if (taskId.trim() !== "") {
        const resolved = await resolution.resolveActiveAttempt(taskId);
        if (resolved.ok) {
          const target = attemptLogPath(runtimeRoot, resolved.attempt.handle.ref, CLAUDE_LOG_CHANNEL);
          if (target.ok) {
            const stamp = await fileStamp(target.value);
            if (stamp.bytes !== undefined) return { ...stamp, source: "attempt" };
          }
        }
      }
      const legacy = await fileStamp(path.join(runtimeRoot, "logs", "claude-last.log"));
      return { ...legacy, source: legacy.bytes === undefined ? "none" : "legacy" };
    },

    inspectProcess,
    uiProcessPid: () => process.pid,
    logError: (message) => input.logError(message),
  };
}
