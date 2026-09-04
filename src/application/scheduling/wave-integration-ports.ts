// Bangos INTEGRACIJOS kontraktai ir bendri primityvai (etalonas: AG_loop
// orchestrator/loop/loop-wave-integration{,-coordinator}.ts).
//
// Integracija yra vienintelė vieta, kur izoliuotas darbas įeina į pagrindinį medį, tad kiekvienas
// jos žingsnis gali nepavykti PO to, kai ankstesnis jau pavyko. Iš to plaukia visų portų forma:
// jie grąžina ĮVARDINTĄ baigtį, o ne `boolean` ir ne išimtį. „Nepavyko" be vardo integracijoje
// reiškia, kad operatorius nežino, ar darbas dingo, ar guli šakoje, ar laukia žmogaus.
//
// Tipai gyvena atskirai nuo vykdymo (`wave-integration-step`, `wave-integration-coordinator`),
// nes abu juos naudoja, o importų grafas privalo likti aciklinis.

import type { WorkerIntegrationStep } from "./worker-integration.js";
import type { WorkerLease } from "../../domain/scheduling/worker-lease-rules.js";

/** Bangos įvykio forma; rašytojas gyvena infrastruktūroje. */
export type WaveIntegrationEvent = {
  run_id: string;
  wave_id: string;
  graph_hash: string;
  event: string;
  task_id?: string;
  reason?: string;
};

/** Kur atsidūrė task'o failas. `absent` NĖRA sėkmė: failo niekur nerasta. */
export type TaskRelocation = "moved" | "already" | "kept" | "absent";

/** Task'o failo atstatymas iš git istorijos, kai merge jį pašalino iš eilės. */
export type DoneCopyRestoreOutcome = { ok: true; source: string } | { ok: false; detail: string };

export type WorktreeCleanupOutcome = {
  worktree: "removed" | "absent" | "forbidden" | "quarantined" | "infrastructure";
  branch: "deleted" | "absent" | "unmerged" | "infrastructure" | "skipped";
  detail: string;
};

export type LeaseReleaseOutcome = "released" | "already-released" | "absent" | "denied" | "failed";

/** Šakos suliejimo baigtis. `absent` reiškia, kad šakos nebėra — tai gali būti ir pėdsakas. */
export type BranchIntegrationOutcome =
  | { status: "integrated"; mode: string; head: string }
  | { status: "absent" }
  | { status: "conflict"; paths: string[] }
  | { status: "refused"; reason: string; detail: string }
  | { status: "infrastructure"; message: string };

/** Kur task'as guli DABAR. `terminal-bucket` reiškia, kad darbas jau užbaigtas. */
export type TaskLocation = "terminal-bucket" | "queue" | "active" | "absent" | "unknown";

export type WorktreeIdentity = {
  run_id: string;
  worker_id: string;
  task_id: string;
  attempt: number;
};

/** Kopijos vieta ir šaka. Neišsprendžiamas maketas yra klaida, ne tuščia reikšmė. */
export type WorktreeLayoutView = { relativePath: string; branch: string };

export type WaveIntegrationPorts = {
  runId: string;
  waveContext: () => { waveId: string; graphHash: string };
  /** Žurnalas ir įvykiai, kurie NIEKADA nemeta — integracija negali kristi dėl telemetrijos. */
  safeLog: (message: string) => Promise<void>;
  safeEvent: (event: WaveIntegrationEvent) => Promise<void>;
  resolveWorktreeLayout: (identity: WorktreeIdentity) => WorktreeLayoutView;
  locateTask: (taskId: string) => Promise<TaskLocation>;
  resolvePrimaryHead: () => Promise<string | undefined>;
  integrateBranch: (input: { branch: string; task_id: string }) => Promise<BranchIntegrationOutcome>;
  /** Ar suliejimas palietė `src` — tik tada verta perstatyti `dist`. */
  integrationTouchedSrc: (input: { before?: string | undefined; after: string }) => Promise<boolean>;
  rebuildDist: () => Promise<{ ok: boolean; detail: string }>;
  /**
   * Ar suliejimas palietė `ui-app/src` — tik tada verta perstatyti UI bundle'ą. Neprivaloma:
   * jos nesant (senesnis ar testinis ports objektas), UI bundle'o perstatymas tiesiog
   * praleidžiamas, o variklio `dist` kelias lieka nepaliestas.
   */
  integrationTouchedUiSrc?: (input: { before?: string | undefined; after: string }) => Promise<boolean>;
  /** UI bundle'o (`ui-app/dist`) perstatymas. Nesėkmė — stebėjimo paviršius, ne vartas. */
  rebuildUiBundle?: () => Promise<{ ok: boolean; detail: string }>;
  pushPrimaryBranch: () => Promise<{ ok: boolean; branch?: string; detail?: string }>;
  relocateTask: (taskId: string, bucket: "done" | "human-review") => Promise<TaskRelocation>;
  restoreDoneCopy: (input: { taskId: string; preMergeHead: string | undefined }) => Promise<DoneCopyRestoreOutcome>;
  /**
   * Vaiko worktree telemetrijos (`context-size.jsonl`, `token-usage.jsonl`) eilučių perkėlimas
   * į pagrindinio medžio žurnalus PRIEŠ `cleanupWorktree` — kitaip matavimai dingsta kartu su
   * kopija. NIEKADA nemeta ir NIEKADA neblokuoja integracijos — ta pati taisyklė kaip
   * `safeLog`/`safeEvent`.
   */
  collectWorktreeTelemetry: (input: { worktreePath: string; task_id: string }) => Promise<{ appended: number; detail: string }>;
  cleanupWorktree: (input: { identity: WorktreeIdentity; lease: WorkerLease; branch: string }) => Promise<WorktreeCleanupOutcome>;
  releaseLease: (leaseId: string) => Promise<LeaseReleaseOutcome>;
};

/** Vienas integracijos žingsnis su jau išspręstu lease'u. */
export type IntegrationStep = WorkerIntegrationStep;

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Kelio palyginimas skyriklio neskiriant: `\` ir `/` yra tas pats kelias. */
export function sameWorktreePath(left: string, right: string): boolean {
  return left.replace(/\\/g, "/") === right.replace(/\\/g, "/");
}

/**
 * Task'o pastatymas į žmogaus peržiūrą — VIENINTELĖ integracijos išeitis, kai kas nors nepavyko.
 *
 * Perkėlimo nesėkmė čia nėra mirtina, bet ji rašoma AIŠKIAI: task'as, likęs eilėje, bus
 * dispatch'intas iš naujo, ir operatorius turi tai matyti žurnale, o ne aiškintis iš tylos.
 */
export function createHumanReviewPark(
  ports: Pick<WaveIntegrationPorts, "runId" | "waveContext" | "safeLog" | "safeEvent" | "relocateTask">,
): (taskId: string, reason: string, detail: string) => Promise<void> {
  return async (taskId, reason, detail): Promise<void> => {
    let relocation: TaskRelocation | "failed" = "failed";
    try {
      relocation = await ports.relocateTask(taskId, "human-review");
    } catch (error) {
      await ports.safeLog(`WORKER INTEGRATION PARK FAILED: task=${taskId}: ${describeError(error)}`);
    }
    await ports.safeLog(
      `WORKER INTEGRATION PARKED: task=${taskId} reason=${reason} task_file=${relocation}` +
        `${relocation === "failed" ? " (TASK'AS LIKO EILĖJE — bus dispatch'intas iš naujo)" : ""} — ${detail}`,
    );
    const context = ports.waveContext();
    await ports.safeEvent({
      run_id: ports.runId,
      wave_id: context.waveId,
      graph_hash: context.graphHash,
      event: "worker_integration_parked",
      task_id: taskId,
      reason: `${reason}; task_file=${relocation}; ${detail}`,
    });
  };
}
