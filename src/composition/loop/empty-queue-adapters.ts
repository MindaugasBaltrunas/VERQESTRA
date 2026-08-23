// Tuščios eilės ir audito remonto adapteriai (manual DI, LAY-2).
//
// Tuščia eilė yra vieta, kur loop'as sprendžia, ar darbas BAIGTAS, ar dar nieko nesuplanuota. Trys
// jos žingsniai (bootstrap, architektūros banga, kokybės auditas) turi visiškai skirtingus efektus,
// todėl kiekvienas gauna savo adapterį, o ne bendrą „paleisk komandą".
//
// Bendra taisyklė: adapteris VERČIA rezultatą į sprendimui reikalingą formą ir nieko nesprendžia
// pats. Pvz. bootstrap'o tinkamumas čia virsta vienu `bootstrapEligible` lauku — ar tuščią eilę
// galima bandyti pripildyti; kodėl būtent taip, sprendžia `handleEmptyQueue`.

import path from "node:path";
import type { EmptyQueuePorts } from "../../application/scheduling/loop-empty-queue.js";
import type { FinalAuditRepairPorts } from "../../application/quality-gates/final-audit-repair.js";
import { isFinalAuditRepairTaskFile, processFinalAuditRepairTask } from "../../application/quality-gates/final-audit-repair.js";
import { synthesizeReadyArchitectureWave } from "../../application/architecture/wave.js";
import { runQualityGates } from "../../application/quality-gates/quality-gates.js";
import { converge } from "../../application/release-readiness/converge-check.js";
import { finishTaskInBucket, type TaskStateStorePort } from "../../application/task-execution/bucket-transition.js";
import { isInfrastructureExitCode } from "../../shared/exit-codes.js";
import { detectBootstrapEligibility } from "../../infrastructure/bootstrap/bootstrap-detector.js";
import { markStableIfSuccess } from "../../infrastructure/git/stable-ref.js";
import { recordResumeCheckpoint } from "../../infrastructure/state/resume-checkpoint.js";
import { recordWaveEvent } from "../../infrastructure/state/wave-events.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { sha256Hex } from "../../shared/hash.js";
import { architectureWavePorts } from "../quality/architecture-adapters.js";
import { bootstrapProjectPorts } from "../runtime/bootstrap-adapters.js";
import { convergePorts } from "../quality/readiness-adapters.js";
import { qualityGatesPorts, resolveModelForTier } from "../quality/adapters.js";
import { appendLogLine } from "./adapters.js";
import { runBootstrapProject, renderBootstrapProject } from "../../interfaces/cli/bootstrap/bootstrap-project.js";
import { taskLedgerStore } from "../runtime/node-adapters.js";
import type { RuntimeRoots } from "../runtime/context.js";

/** Modelio pakopa, kuria dirba bootstrap'as. Ta pati reikšmė kaip etalone. */
const BOOTSTRAP_MODEL_TIER = "planning";

export type EmptyQueueAdapterDeps = {
  roots: RuntimeRoots;
  out: (message: string) => void;
  /** CLI žingsnio paleidimas (`claude-dispatch`, `quality-gates`) — tas pats kelias kaip loop'e. */
  runCommand: (args: string[]) => Promise<number>;
  taskStore: TaskStateStorePort;
  env?: NodeJS.ProcessEnv;
};

export function emptyQueuePorts(deps: EmptyQueueAdapterDeps): EmptyQueuePorts {
  const { projectRoot, runtimeRoot } = deps.roots;
  const log = (message: string): Promise<void> => appendLogLine(runtimeRoot, "orchestrator.log", message);

  return {
    detectBootstrapEligibility: async (root) => ({ bootstrapEligible: (await detectBootstrapEligibility(root)).bucketsEmpty }),
    runBootstrap: async (root) => {
      const result = await runBootstrapProject({
        ports: bootstrapProjectPorts(root, runtimeRoot),
        projectRoot: root,
      });
      return { status: result.status, render: renderBootstrapProject(result) };
    },
    resolveModel: () => resolveModelForTier(runtimeRoot, BOOTSTRAP_MODEL_TIER),
    synthesizeWave: async (root) => {
      const wave = await synthesizeReadyArchitectureWave(architectureWavePorts(root), root);
      // Perduodamas PJŪVIS, ne visas rezultatas: `nodeResults` yra bangos detalė, o sprendimui
      // reikia tik skaičių — didesnis paviršius čia reikštų, kad sprendimas gali imti tai, ko
      // kontraktas nežada.
      return {
        status: wave.status,
        synthesized: wave.synthesized,
        blocked: wave.blocked,
        done: wave.done,
        total: wave.total,
        already_implemented: wave.already_implemented,
        external_satisfied: wave.external_satisfied,
        no_evidence: wave.no_evidence,
      };
    },
    runQualityGates: async () => (await runQualityGates(qualityGatesPorts(runtimeRoot, projectRoot), [], { projectRoot })).exit_code,
    // Remonto ciklas yra atskiras use case: čia tik jo portų suvedimas.
    dispatchAuditRepair: async (content) => {
      await processFinalAuditRepairTask(finalAuditRepairPorts(deps), content);
    },
    runConverge: async (root) => await converge(convergePorts, { projectRoot: root, runtimeRoot }),
    log,
    out: deps.out,
    env: deps.env ?? process.env,
  };
}

/** Audito remonto portai: tas pats ledger'is, tie patys žurnalai, tas pats CLI kelias. */
export function finalAuditRepairPorts(deps: EmptyQueueAdapterDeps): FinalAuditRepairPorts {
  const { agRoot, runtimeRoot, projectRoot } = deps.roots;
  const ledger = taskLedgerStore(runtimeRoot);

  return {
    pendingHumanReview: async () => {
      const dir = path.join(agRoot, "tasks", "human-review");
      const names = (await nodeFsAdapter.listDirectoryIfExists(dir)) ?? [];
      return names.filter((name) => isFinalAuditRepairTaskFile(name));
    },
    writeTaskFile: async (taskName, content) => {
      const file = path.join(agRoot, "tasks", "error", taskName);
      await nodeFsAdapter.makeDirectory(path.dirname(file));
      await nodeFsAdapter.writeTextFile(file, content);
      return file;
    },
    fingerprint: async (absolutePath) => sha256Hex(await nodeFsAdapter.readFileBytes(absolutePath)),
    recordState: async (taskId, taskName, state, file, fingerprint) => {
      const entries = await ledger.read();
      await ledger.write({
        ...entries,
        [taskId]: { ...entries[taskId], task_name: taskName, state, file, fingerprint, updated_at: new Date().toISOString() },
      });
    },
    // Checkpoint'as rašomas per tą patį kelią kaip visi kiti.
    recordCheckpoint: (checkpoint) => recordResumeCheckpoint({ projectRoot, runtimeRoot, checkpoint }),
    recordEvent: async (event) => {
      await recordWaveEvent(runtimeRoot, {
        run_id: "final-audit-repair",
        wave_id: "none",
        graph_hash: "none",
        event: event.reason,
        task_id: event.task_id,
        reason: `${event.phase}; to_state=${event.to_state}${event.exit_code === undefined ? "" : `; exit=${event.exit_code}`}`,
      });
    },
    runCommand: deps.runCommand,
    moveTask: (fromFile, state, taskName) => finishTaskInBucket(deps.taskStore, agRoot, fromFile, state, taskName),
    markStable: () => markStableIfSuccess(projectRoot, runtimeRoot),
    log: (message) => appendLogLine(runtimeRoot, "orchestrator.log", message),
    isInfrastructureExitCode,
    logFilePath: (name) => path.join(runtimeRoot, "logs", name),
  };
}
