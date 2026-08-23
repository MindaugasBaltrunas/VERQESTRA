// SSE srauto adapteriai (manual DI, LAY-2): gyvi slot'ai, jų bandymo keliai ir stebimi failai.
//
// Srautas yra ATASKAITA, ne vartai. Iš to plaukia visų šio failo adapterių taisyklė: nė vienas jų
// neturi teisės nuversti srauto. Neperskaitytas snapshot'as reiškia „gyvų slot'ų nežinome" ir
// grąžina tuščią sąrašą; neišspręstas bandymas — globalų veidrodį su ĮVARDINTA kilme
// (`stopStatusSource`), o ne apsimestinį įrodymą.
//
// Bandymo rezoliucija čia kviečiama BE kešo (`active-attempt` jo neturi sąmoningai): šis kelias
// pollinamas kas 1,5 s, ir memoizuota sėkmė amžinai užšaldytų SENO bandymo įrodymą po `a1 → a2`
// perėjimo.

import path from "node:path";
import { readAgentActivity } from "../../interfaces/ui-model/agent-activity-reader.js";
import type { AgentActivity } from "../../interfaces/ui-model/agent-activity.js";
import type { SseActiveAttempt, SseLiveSlotSource, SsePorts } from "../../interfaces/http/sse-service.js";
import { waveSnapshotSchema } from "../../application/scheduling/wave-snapshot.js";
import { formatAttemptId, type AttemptRef } from "../../application/scheduling/worker-limits.js";
import { attemptArtifactPath, attemptLogPath } from "../../infrastructure/runtime-paths.js";
import { resolveActiveAttempt } from "../../infrastructure/state/active-attempt.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { tryParseJson } from "../../shared/json.js";

/** Claude srauto kanalas bandymo viduje — tas pats vardas kaip globaliame veidrodyje. */
const CLAUDE_LOG_CHANNEL = "claude-last";

export type SseAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
};

/** Repo-reliatyvus posix kelias rodymui — kilmė matoma, o ne nutylima. */
function relativePosix(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

async function readWaveSnapshotLiveSlots(
  runtimeRoot: string,
): Promise<{ run_id: string; live_slots: { worker_id: string; task_id: string; attempt: number }[] } | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "state", "wave-snapshot.json"));
  if (raw === undefined) return undefined;
  const parsed = tryParseJson<unknown>(raw);
  if (!parsed.ok) return undefined;
  const validated = waveSnapshotSchema.safeParse(parsed.value);
  if (!validated.success) return undefined;
  return { run_id: validated.data.run_id, live_slots: validated.data.live_slots };
}

export function ssePorts(input: SseAdapterInput): Omit<SsePorts, "setInterval"> {
  const { projectRoot, runtimeRoot } = input;
  const fs = { readTextFileIfExists: (file: string) => nodeFsAdapter.readTextFileIfExists(file) };

  return {
    fileMtimeMs: async (absolutePath) => (await nodeFsAdapter.fileMtimeMs(absolutePath)) ?? 0,

    readGlobalActivity: () => readAgentActivity({ fs }, runtimeRoot),

    // Slot'o aktyvumas imamas iš JO bandymo artefaktų, o sesijos tapatybė paduodama tiesiogiai:
    // globalus `claude-resume.json` aprašo KITĄ slot'ą, tad jo būsena čia būtų melas.
    readSlotActivity: (source: SseLiveSlotSource): Promise<AgentActivity> =>
      readAgentActivity({ fs }, runtimeRoot, {
        logPath: source.logPath,
        taskFilePath: source.taskFilePath,
        session: { taskId: source.task_id, status: "running" },
      }),

    async readLiveSlotSources(): Promise<SseLiveSlotSource[]> {
      const snapshot = await readWaveSnapshotLiveSlots(runtimeRoot);
      if (snapshot === undefined) return [];

      const sources: SseLiveSlotSource[] = [];
      for (const slot of snapshot.live_slots) {
        const ref: AttemptRef = {
          runId: snapshot.run_id,
          workerId: slot.worker_id,
          taskId: slot.task_id,
          attemptId: formatAttemptId(slot.attempt),
        };
        const logPath = attemptLogPath(runtimeRoot, ref, CLAUDE_LOG_CHANNEL);
        const taskPath = attemptArtifactPath(runtimeRoot, ref, "task");
        // Netinkamas segmentas (pvz. senas snapshot'as su svetimos formos id) PRALEIDŽIAMAS:
        // vienas neteisėtas slot'as negali nutildyti viso srauto.
        if (!logPath.ok || !taskPath.ok) continue;
        sources.push({
          worker_id: slot.worker_id,
          task_id: slot.task_id,
          attempt: slot.attempt,
          log_path: relativePosix(projectRoot, logPath.value),
          logPath: logPath.value,
          taskFilePath: taskPath.value,
        });
      }
      return sources;
    },

    async readActiveAttempt(): Promise<SseActiveAttempt | undefined> {
      const snapshot = await readWaveSnapshotLiveSlots(runtimeRoot);
      const taskId = snapshot?.live_slots[0]?.task_id;
      if (taskId === undefined) return undefined;

      const resolved = await resolveActiveAttempt({ taskId, projectRoot, runtimeRoot });
      if (!resolved.ok) {
        // Bandymo kopijos dar nėra: rodomas globalus veidrodis, ir tai PASAKOMA (`legacy`), o ne
        // pateikiama kaip bandymo įrodymas.
        return { taskId, watchFiles: [], stopStatusSource: "legacy" };
      }

      const ref: AttemptRef = {
        runId: resolved.attempt.manifest.run_id,
        workerId: resolved.attempt.manifest.worker_id,
        taskId: resolved.attempt.manifest.task_id,
        attemptId: resolved.attempt.manifest.attempt_id,
      };
      const stopStatus = attemptArtifactPath(runtimeRoot, ref, "stop-state");
      const claudeLog = attemptLogPath(runtimeRoot, ref, CLAUDE_LOG_CHANNEL);
      const watchFiles = [stopStatus, claudeLog].filter((result) => result.ok).map((result) => (result.ok ? result.value : ""));

      return {
        taskId,
        watchFiles,
        stopStatusSource: stopStatus.ok ? relativePosix(projectRoot, stopStatus.value) : "legacy",
      };
    },

    legacyWatchFiles: () => [
      path.join(runtimeRoot, "state", "claude-resume.json"),
      path.join(runtimeRoot, "state", "wave-snapshot.json"),
      path.join(runtimeRoot, "state", "stop-status.json"),
      path.join(runtimeRoot, "logs", "claude-last.log"),
    ],
  };
}
