// VIENO slot'o integracija: šaka → dist → push → lease → task failas → kopijos valymas
// (etalonas: AG_loop orchestrator/loop/loop-wave-integration-coordinator.ts `integrateStep`).
//
// Žingsnių tvarka nėra skonio reikalas — ji seka iš to, ką kiekvienas jų padaro negrįžtamai:
//   1. maketas ir kelio sutapimas — PRIEŠ bet kokį rašymą: nesutampantis kelias reiškia, kad
//      lease ir slot'as kalba apie skirtingas kopijas, ir suliejimas paimtų svetimą darbą;
//   2. suliejimas — vienintelis žingsnis, po kurio darbas jau yra pagrindiniame medyje;
//   3. `dist` perstatymas — TIK jei suliejimas palietė `src`, ir jo nesėkmė stabdo viską, nes
//      sulietas kodas su senu `dist` yra būsena, kurios niekas nepatikrino;
//   4. push — best-effort: nepavykęs push'as nieko nesugadina, darbas jau medyje;
//   5. lease, task failas, kopijos valymas — tvarkymasis po sėkmės.
//
// Kiekviena nesėkmė iki 3 imtinai baigiasi ŽMOGAUS PERŽIŪRA, o ne tyliu praleidimu: neintegruotas
// darbas, apie kurį niekas nežino, yra blogesnis nei sustabdytas task'as.

import {
  createHumanReviewPark,
  describeError,
  sameWorktreePath,
  type BranchIntegrationOutcome,
  type DoneCopyRestoreOutcome,
  type IntegrationStep,
  type TaskLocation,
  type TaskRelocation,
  type WaveIntegrationPorts,
  type WorktreeCleanupOutcome,
  type WorktreeIdentity,
  type WorktreeLayoutView,
} from "./wave-integration-ports.js";

export type IntegrationStepRunner = {
  run: (step: IntegrationStep) => Promise<void>;
  park: (taskId: string, reason: string, detail: string) => Promise<void>;
  releaseLeaseSafely: (leaseId: string) => Promise<string>;
};

export function createIntegrationStepRunner(
  ports: WaveIntegrationPorts,
  releasedLeaseIds: Set<string>,
): IntegrationStepRunner {
  const park = createHumanReviewPark(ports);

  const releaseLeaseSafely = async (leaseId: string): Promise<string> => {
    try {
      return await ports.releaseLease(leaseId);
    } catch (error) {
      await ports.safeLog(`WORKER INTEGRATION LEASE RELEASE FAILED: lease=${leaseId}: ${describeError(error)}`);
      return "failed";
    }
  };

  const primaryHeadSafely = async (): Promise<string | undefined> => {
    try {
      return await ports.resolvePrimaryHead();
    } catch (error) {
      // Neišspręstas HEAD nėra stabdis: jis naudojamas tik kaip ATSARGINIS ref'as task'o failui
      // atstatyti, ir jo nebuvimas tiesiog palieka `HEAD^`.
      await ports.safeLog(`INTEGRATION HEAD UNRESOLVED: ${describeError(error)}`);
      return undefined;
    }
  };

  const rebuildDistAfterMerge = async (
    taskId: string,
    branch: string,
    before: string | undefined,
    after: string,
  ): Promise<{ ok: boolean; detail: string }> => {
    // Neatsakius į klausimą „ar palietė src", atsakymas yra TAIP: nereikalingas perstatymas
    // kainuoja laiką, praleistas — paliekami nepatikrinti dist artefaktai.
    let touched = true;
    try {
      touched = await ports.integrationTouchedSrc({ before, after });
    } catch (error) {
      await ports.safeLog(`INTEGRATION DIST DIFF FAILED: task=${taskId}: ${describeError(error)}`);
    }
    if (!touched) return { ok: true, detail: "" };

    let outcome: { ok: boolean; detail: string };
    try {
      outcome = await ports.rebuildDist();
    } catch (error) {
      outcome = { ok: false, detail: describeError(error) };
    }
    if (outcome.ok) await ports.safeLog(`INTEGRATION DIST REBUILT: task=${taskId} branch=${branch} head=${after}`);
    return outcome;
  };

  // Atskiras nuo `rebuildDistAfterMerge`, nes UI bundle'as yra STEBĖJIMO paviršius, ne vartas:
  // nesėkmė čia niekada nepastato task'o į human-review, kitaip žalias merge'as parkuotų dėl
  // vite klaidos. Neprivalomi portai (senesni/testiniai ports objektai be jų) tiesiog praleidžia
  // žingsnį — variklio `dist` kelias tuo nepaveikiamas.
  const rebuildUiBundleAfterMerge = async (
    taskId: string,
    branch: string,
    before: string | undefined,
    after: string,
  ): Promise<void> => {
    if (!ports.integrationTouchedUiSrc || !ports.rebuildUiBundle) return;

    let touched = true;
    try {
      touched = await ports.integrationTouchedUiSrc({ before, after });
    } catch (error) {
      await ports.safeLog(`INTEGRATION UI BUNDLE DIFF FAILED: task=${taskId}: ${describeError(error)}`);
    }
    if (!touched) return;

    let outcome: { ok: boolean; detail: string };
    try {
      outcome = await ports.rebuildUiBundle();
    } catch (error) {
      outcome = { ok: false, detail: describeError(error) };
    }
    await ports.safeLog(
      outcome.ok
        ? `INTEGRATION UI BUNDLE REBUILT: task=${taskId} head=${after}`
        : `INTEGRATION UI BUNDLE REBUILD FAILED: task=${taskId} branch=${branch} head=${after}: ${outcome.detail}`,
    );
  };

  /** Ar suliejimo baigtis leidžia tęsti. Kiekvienas „ne" turi savo VARDĄ žurnale. */
  const mergeBlocked = async (step: IntegrationStep, branch: string, merge: BranchIntegrationOutcome): Promise<boolean> => {
    if (merge.status === "conflict") {
      await park(step.task_id, "merge-conflict", `${branch}: ${merge.paths.join(", ")}`);
      return true;
    }
    if (merge.status === "refused") {
      await park(step.task_id, `merge-${merge.reason}`, merge.detail);
      return true;
    }
    if (merge.status === "infrastructure") {
      await park(step.task_id, "merge-infrastructure", merge.message);
      return true;
    }
    if (merge.status === "absent") {
      // Šakos nebėra. Tai LEISTINA tik tada, kai task'as jau terminaliniame bucket'e — tada
      // dingusi šaka yra ankstesnės integracijos pėdsakas, o ne prarastas darbas.
      let located: TaskLocation = "unknown";
      try {
        located = await ports.locateTask(step.task_id);
      } catch (error) {
        await ports.safeLog(`WORKER INTEGRATION LOCATE FAILED: task=${step.task_id}: ${describeError(error)}`);
      }
      if (located !== "terminal-bucket") {
        await park(
          step.task_id,
          "merge-branch-absent",
          `šakos ${branch} nebėra, o task'as yra "${located}" — ankstesnės integracijos pėdsako nėra`,
        );
        return true;
      }
    }
    return false;
  };

  const settleTaskFile = async (
    step: IntegrationStep,
    preMergeHead: string | undefined,
  ): Promise<TaskRelocation | "restored" | undefined> => {
    let relocation: TaskRelocation;
    try {
      relocation = await ports.relocateTask(step.task_id, "done");
    } catch (error) {
      await park(step.task_id, "task-move-failed", describeError(error));
      return undefined;
    }
    if (relocation !== "absent") return relocation;

    // Failo eilėje nebėra: jį pašalino pats suliejimas. Turinys atstatomas iš istorijos, nes
    // be task failo užbaigtas darbas neturi jokio pėdsako eilėje.
    let restored: DoneCopyRestoreOutcome;
    try {
      restored = await ports.restoreDoneCopy({ taskId: step.task_id, preMergeHead });
    } catch (error) {
      restored = { ok: false, detail: describeError(error) };
    }
    if (!restored.ok) {
      await park(step.task_id, "done-copy-restore-failed", restored.detail);
      return undefined;
    }
    await ports.safeLog(`WORKER INTEGRATION TASK FILE RESTORED: task=${step.task_id} source=${restored.source}`);
    return "restored";
  };

  const run = async (step: IntegrationStep): Promise<void> => {
    const identity: WorktreeIdentity = {
      run_id: step.lease.run_id,
      worker_id: step.lease.worker_id,
      task_id: step.lease.task_id,
      attempt: step.lease.attempt,
    };

    let layout: WorktreeLayoutView;
    try {
      layout = ports.resolveWorktreeLayout(identity);
    } catch (error) {
      await park(step.task_id, "layout-unresolved", describeError(error));
      return;
    }
    if (!sameWorktreePath(layout.relativePath, step.worktree_path)) {
      // Lease ir slot'as kalba apie skirtingas kopijas — suliejimas paimtų svetimą darbą.
      await park(step.task_id, "worktree-path-mismatch", `lease=${layout.relativePath} slot=${step.worktree_path}`);
      return;
    }

    // HEAD skaitomas PRIEŠ suliejimą: po jo tai jau kitas commit'as, ir atstatymo ref'as dingtų.
    const preMergeHead = await primaryHeadSafely();
    let merge: BranchIntegrationOutcome;
    try {
      merge = await ports.integrateBranch({ branch: layout.branch, task_id: step.task_id });
    } catch (error) {
      await park(step.task_id, "merge-failed", describeError(error));
      return;
    }
    if (await mergeBlocked(step, layout.branch, merge)) return;

    await ports.safeLog(
      `WORKER INTEGRATION MERGED: task=${step.task_id} branch=${layout.branch} status=${merge.status}` +
        `${merge.status === "integrated" ? ` mode=${merge.mode}` : ""}`,
    );

    if (merge.status === "integrated") {
      const rebuild = await rebuildDistAfterMerge(step.task_id, layout.branch, preMergeHead, merge.head);
      if (!rebuild.ok) {
        await park(step.task_id, "dist-rebuild-failed", `INTEGRATION DIST REBUILD FAILED: ${rebuild.detail}`);
        return;
      }
      await rebuildUiBundleAfterMerge(step.task_id, layout.branch, preMergeHead, merge.head);
    }

    try {
      const pushed = await ports.pushPrimaryBranch();
      // Push best-effort: darbas jau pagrindiniame medyje, tad nepavykęs push'as nieko nepraranda.
      await ports.safeLog(
        pushed.ok
          ? `WORKER INTEGRATION PUSHED: task=${step.task_id} branch=${pushed.branch ?? "?"}`
          : `INTEGRATION PUSH FAILED: ${pushed.detail ?? "be detalės"}`,
      );
    } catch (error) {
      await ports.safeLog(`INTEGRATION PUSH FAILED: ${describeError(error)}`);
    }

    const leaseOutcome = await releaseLeaseSafely(step.lease.lease_id);
    // Žymima NEPRIKLAUSOMAI nuo baigties: pakartotinis to paties lease atlaisvinimas bangos
    // pabaigoje nieko neišspręstų, o žurnale atrodytų kaip antras įvykis.
    releasedLeaseIds.add(step.lease.lease_id);

    const taskFileOutcome = await settleTaskFile(step, preMergeHead);
    if (taskFileOutcome === undefined) return;

    try {
      const harvested = await ports.collectWorktreeTelemetry({ worktreePath: layout.relativePath, task_id: step.task_id });
      if (harvested.appended > 0 || harvested.detail !== "") {
        await ports.safeLog(
          `INTEGRATION TELEMETRY HARVESTED: task=${step.task_id} appended=${harvested.appended}` +
            `${harvested.detail === "" ? "" : ` detail=${harvested.detail}`}`,
        );
      }
    } catch (error) {
      await ports.safeLog(`INTEGRATION TELEMETRY HARVEST FAILED: task=${step.task_id}: ${describeError(error)}`);
    }

    let cleanup: WorktreeCleanupOutcome;
    try {
      cleanup = await ports.cleanupWorktree({ identity, lease: step.lease, branch: layout.branch });
    } catch (error) {
      cleanup = { worktree: "infrastructure", branch: "skipped", detail: describeError(error) };
    }
    // Likutis (nepašalinta kopija ar šaka) integracijos NEATŠAUKIA — darbas jau medyje. Bet jis
    // ĮVARDIJAMAS, nes kitaip orphan'ai kauptųsi tyliai iki disko pabaigos.
    const cleaned =
      (cleanup.worktree === "removed" || cleanup.worktree === "absent") &&
      (cleanup.branch === "deleted" || cleanup.branch === "absent");
    const line =
      `task=${step.task_id} branch=${layout.branch} merge=${merge.status} task_file=${taskFileOutcome} ` +
      `lease=${leaseOutcome} worktree=${cleanup.worktree} branch_cleanup=${cleanup.branch}` +
      `${cleanup.detail === "" ? "" : ` detail=${cleanup.detail}`}`;
    await ports.safeLog(`WORKER INTEGRATION ${cleaned ? "COMPLETED" : "COMPLETED WITH RESIDUE"}: ${line}`);

    const context = ports.waveContext();
    await ports.safeEvent({
      run_id: ports.runId,
      wave_id: context.waveId,
      graph_hash: context.graphHash,
      event: "worker_integration_completed",
      task_id: step.task_id,
      reason: line,
    });
  };

  return { run, park, releaseLeaseSafely };
}
