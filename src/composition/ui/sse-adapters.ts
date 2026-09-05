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
import { buildAgentActivity, type AgentActivity } from "../../interfaces/ui-model/agent-activity.js";
import type { SseActiveAttempt, SseLiveSlotSource, SsePorts } from "../../interfaces/http/sse-service.js";
import { waveSnapshotSchema } from "../../application/scheduling/wave-snapshot.js";
import { listWorkerLeases } from "../../application/scheduling/worker-lease-store.js";
import { formatAttemptId, type AttemptRef } from "../../application/scheduling/worker-limits.js";
import { attemptArtifactPath, attemptLogPath, type RuntimePathResult } from "../../infrastructure/runtime-paths.js";
import { resolveActiveAttempt } from "../../infrastructure/state/active-attempt.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { tryParseJson } from "../../shared/json.js";
import { schedulingFs } from "../loop/adapters.js";

/** Claude srauto kanalas bandymo viduje — tas pats vardas kaip globaliame veidrodyje. */
const CLAUDE_LOG_CHANNEL = "claude-last";

/**
 * Bandymo rezoliucija plius vienintelė papildoma žinia, kurios reikia ABIEM srauto keliams:
 * ar tėvo srauto kanalas jau egzistuoja diske.
 */
type AttemptLogState =
  | { resolved: false }
  | {
      resolved: true;
      /** Iš MANIFESTO išvestas ref — iš jo skaičiuojamas ir stop įrodymo kelias. */
      ref: AttemptRef;
      claudeLog: RuntimePathResult<string>;
      /** Bandymas rezoliuotas, bet tėvo `claude-last` kanalo dar nėra = worktree dispatch'as. */
      parentLogMissing: boolean;
    };

export type SseAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
  /** Nepavykusio praėjimo pranešimas; be jo srauto gedimas nepaliktų pėdsako niekur. */
  logError(message: string): void;
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

  /**
   * Task 139: worktree dispatch'o gyvas srautas gyvena KOPIJOS `vq/logs/claude-last.log` —
   * vaikas rašo su savo runtimeRoot, tad tėvo attempt kanalas užsipildo tik kopija pabaigoje,
   * o globalus veidrodis lieka paskutinio NE-worktree dispatch'o fosilija (2026-09-01: UI
   * „gyva komanda" rodė 8 val. senumo eilutę). Kelias į kopiją išvedamas iš GYVO lease
   * (`worktree_path` — pagrindinio medžio vq/state), o ne spėjamas; nesant lease ar failo —
   * `undefined`, ir kvietėjas lieka prie esamo elgesio (tuščia veikla, ne fosilija).
   */
  const worktreeLiveSources = async (
    taskId: string,
  ): Promise<{ logPath: string; taskFilePath: string } | undefined> => {
    try {
      const leases = await listWorkerLeases(schedulingFs, projectRoot);
      const lease = leases.find((entry) => entry.status === "held" && entry.task_id === taskId && entry.worktree_path);
      if (!lease?.worktree_path) return undefined;
      const worktreeRoot = path.resolve(projectRoot, lease.worktree_path);
      const logPath = path.join(worktreeRoot, "vq", "logs", "claude-last.log");
      if (!(await nodeFsAdapter.exists(logPath))) return undefined;
      // Grandinei — dispatch'o prompt'as kopijos supervisor kataloge: jis neša task tekstą su
      // `## Agentai`. Nesamas failas ne klaida — reader'is tuščią turinį toleruoja.
      return { logPath, taskFilePath: path.join(worktreeRoot, "vq", "supervisor", "claude-visible-prompt.md") };
    } catch {
      // Srautas yra ataskaita, ne vartai: lease skaitymo klaida negali nuversti SSE.
      return undefined;
    }
  };

  /**
   * Task 232 (auditas 2026-09-05, F9): VIENA rezoliucija abiem srauto keliams. `readActiveAttempt`
   * sprendžia, ką STEBĖTI, `readGlobalActivity` — ką RODYTI, ir iki šio task'o jos matė skirtingą
   * būseną: pirmoji atpažindavo „bandymas rezoliuotas, bet tėvo `claude-last` kanalo dar nėra"
   * (worktree dispatch'as) ir sekė kopijos veidrodį, o antroji tą patį atvejį atiduodavo globaliam
   * veidrodžiui — t. y. srautas reaguodavo į kopijos log'ą, o rodydavo ankstesnio NE-worktree
   * paleidimo fosiliją.
   *
   * `parentLogMissing` yra `claudeLog.ok && !exists`, o NE `!claudeLog.ok || !exists`: neišvedamas
   * kelias (svetimos formos segmentas) nėra įrodymas, kad srautas gyvena kopijoje, ir abu keliai
   * tokiu atveju lieka prie esamo elgesio — kaip `readActiveAttempt` darė nuo task 139.
   */
  const resolveAttemptLog = async (taskId: string): Promise<AttemptLogState> => {
    const resolved = await resolveActiveAttempt({ taskId, projectRoot, runtimeRoot });
    if (!resolved.ok) return { resolved: false };

    const ref: AttemptRef = {
      runId: resolved.attempt.manifest.run_id,
      workerId: resolved.attempt.manifest.worker_id,
      taskId: resolved.attempt.manifest.task_id,
      attemptId: resolved.attempt.manifest.attempt_id,
    };
    const claudeLog = attemptLogPath(runtimeRoot, ref, CLAUDE_LOG_CHANNEL);
    return {
      resolved: true,
      ref,
      claudeLog,
      parentLogMissing: claudeLog.ok && !(await nodeFsAdapter.exists(claudeLog.value)),
    };
  };

  return {
    fileMtimeMs: async (absolutePath) => (await nodeFsAdapter.fileMtimeMs(absolutePath)) ?? 0,

    /**
     * Task 139-a-02: bazinis (ne-slot'inis) aktyvumas, kurį „Aktyvus vykdymas" panelė rodo, kai
     * tėvas negali rezoliuoti bandymo pats. Numatytasis kritimas į `<runtimeRoot>/logs/claude-last.log`
     * yra teisingas TIK kai tas failas realiai priklauso einamam vykdymui (ne-worktree dispatch —
     * tada tėvas jį rašo pats, tad jis šviežias). Kai gyvas slot'as yra, bet tėvo bandymo
     * rezoliucija nepavyksta (worktree dispatch), tas pats failas yra ANKSTESNIO NE-worktree
     * paleidimo fosilija — jis rodomas kaip veiklos turinys, nors su šiuo vykdymu neturi nieko
     * bendro. Todėl čia naudojama ta PATI rezoliucija kaip `readActiveAttempt` ({@link
     * resolveAttemptLog}): radus gyvą worktree lease, turinys imamas iš JO srauto; nesant lease ar
     * failo — grąžinama TUŠČIA veikla (žinomas tik `taskId`/`status`, jokio spėjamo turinio), o ne
     * fosilija.
     *
     * Task 232: rezoliuotas bandymas VIENAS savaime veidrodžio nepateisina. Worktree dispatch'e
     * tėvo bandymo kopija egzistuoja (manifestas rašomas tėvo pusėje), o jos `claude-last` kanalas
     * — ne, nes vaikas rašo su savo runtimeRoot. Būtent tas atvejis anksčiau iškrisdavo pro
     * `if (resolved.ok)` tiesiai į fosiliją.
     */
    async readGlobalActivity(): Promise<AgentActivity> {
      const snapshot = await readWaveSnapshotLiveSlots(runtimeRoot);
      const taskId = snapshot?.live_slots[0]?.task_id;
      if (taskId === undefined) return readAgentActivity({ fs }, runtimeRoot);

      const attempt = await resolveAttemptLog(taskId);
      if (attempt.resolved && !attempt.parentLogMissing) return readAgentActivity({ fs }, runtimeRoot);

      const worktree = await worktreeLiveSources(taskId);
      if (worktree === undefined) {
        return buildAgentActivity({
          taskContent: "",
          logContent: "",
          session: { taskId, status: "running" },
          now: new Date(),
        });
      }
      return readAgentActivity({ fs }, runtimeRoot, {
        logPath: worktree.logPath,
        taskFilePath: worktree.taskFilePath,
        session: { taskId, status: "running" },
        liveExecution: true,
      });
    },

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
        const stopState = attemptArtifactPath(runtimeRoot, ref, "stop-state");
        // Netinkamas segmentas (pvz. senas snapshot'as su svetimos formos id) PRALEIDŽIAMAS:
        // vienas neteisėtas slot'as negali nutildyti viso srauto.
        if (!logPath.ok || !taskPath.ok) continue;
        // Task 139: tėvo attempt kanalas worktree dispatch'e gyvai nerašomas — kol failo nėra,
        // gyvu šaltiniu tampa kopijos veidrodis per lease. Tėvo failas, vos atsiradęs (pabaigos
        // kopija ar būsimas TEE), atgauna pirmenybę.
        const worktree = (await nodeFsAdapter.exists(logPath.value)) ? undefined : await worktreeLiveSources(slot.task_id);
        sources.push({
          worker_id: slot.worker_id,
          task_id: slot.task_id,
          attempt: slot.attempt,
          log_path: relativePosix(projectRoot, worktree?.logPath ?? logPath.value),
          logPath: worktree?.logPath ?? logPath.value,
          taskFilePath: worktree?.taskFilePath ?? taskPath.value,
          // Stop įrodymas stebimas per slot'ą, ne tik pirmam (`readActiveAttempt`).
          ...(stopState.ok ? { stopStatePath: stopState.value } : {}),
        });
      }
      return sources;
    },

    async readActiveAttempt(): Promise<SseActiveAttempt | undefined> {
      const snapshot = await readWaveSnapshotLiveSlots(runtimeRoot);
      const taskId = snapshot?.live_slots[0]?.task_id;
      if (taskId === undefined) return undefined;

      const attempt = await resolveAttemptLog(taskId);
      if (!attempt.resolved) {
        // Bandymo kopijos dar nėra: stebimas worktree veidrodis (task 139), jei gyvas lease jį
        // turi — kitaip rodomas globalus, ir tai PASAKOMA (`legacy`), o ne pateikiama kaip
        // bandymo įrodymas.
        const worktree = await worktreeLiveSources(taskId);
        return {
          taskId,
          watchFiles: worktree ? [worktree.logPath] : [],
          stopStatusSource: "legacy",
        };
      }

      const stopStatus = attemptArtifactPath(runtimeRoot, attempt.ref, "stop-state");
      const watchFiles = [stopStatus, attempt.claudeLog]
        .filter((result) => result.ok)
        .map((result) => (result.ok ? result.value : ""));

      // Task 139: kol tėvo attempt log'as neegzistuoja (worktree dispatch'as rašo kopijoje),
      // stebimas kopijos veidrodis — kitaip SSE neturi kam reaguoti visą dispatch'ą.
      if (attempt.parentLogMissing) {
        const worktree = await worktreeLiveSources(taskId);
        if (worktree) watchFiles.push(worktree.logPath);
      }

      return {
        taskId,
        watchFiles,
        stopStatusSource: stopStatus.ok ? relativePosix(projectRoot, stopStatus.value) : "legacy",
      };
    },

    logError: (message) => input.logError(message),

    legacyWatchFiles: () => [
      path.join(runtimeRoot, "state", "claude-resume.json"),
      path.join(runtimeRoot, "state", "wave-snapshot.json"),
      path.join(runtimeRoot, "state", "stop-status.json"),
      path.join(runtimeRoot, "logs", "claude-last.log"),
    ],
  };
}
