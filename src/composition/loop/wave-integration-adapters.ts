// Bangos integracijos adapteriai (manual DI, LAY-2): `WaveIntegrationPorts` realizacija ant git
// medžio, task bucket'ų ir lease store.
//
// Application pusė (`wave-integration-step`) žino tik ĮVARDINTAS baigtis; čia gyvena visas
// vertimas iš git tikrovės į tuos vardus. Taisyklė viena ir ji galioja kiekvienam adapteriui:
// baigties reikšmė renkama pagal FAKTĄ (ref'as yra/nėra, failas yra/nėra), o ne pagal git
// pranešimo tekstą — teksto atpažinimas lūžta su kiekviena git versija ir kiekviena locale.
//
// NUKRYPIMAS nuo etalono (griežtinantis): `dist` perstatymas kviečia šio repo `pnpm build`
// šaknyje, o ne `npm run build --prefix AG/orchestrator` — VERQESTRA yra vienas paketas, ir
// build'as, rodantis į svetimą katalogą, tyliai perstatytų ne tai, kas buvo sulieta.

import path from "node:path";
import { finishTaskInBucket, taskBucketDir, type TaskStateStorePort } from "../../application/task-execution/bucket-transition.js";
import { leaseClaimOf, type WorkerLease } from "../../domain/scheduling/worker-lease-rules.js";
import { releaseWorkerLease, type WorkerLeaseStoreDeps } from "../../application/scheduling/worker-lease-store.js";
import { isTerminalBucket, taskBuckets, type TaskBucket } from "../../domain/tasks/index.js";
import type {
  BranchIntegrationOutcome,
  DoneCopyRestoreOutcome,
  LeaseReleaseOutcome,
  TaskLocation,
  TaskRelocation,
  WorktreeCleanupOutcome,
  WorktreeIdentity,
  WorktreeLayoutView,
} from "../../application/scheduling/wave-integration-ports.js";
import { gitResolveCommit } from "../../infrastructure/git/git-client.js";
import { pushPrimaryBranch } from "../../infrastructure/git/git-automation.js";
import { integrationTouchedOrchestratorSrc } from "../../infrastructure/git/integration-build-impact.js";
import { deleteWorktreeBranch, integrateWorktreeBranch } from "../../infrastructure/git/worktrees/worktree-branch-integration.js";
import { removeTaskWorktree } from "../../infrastructure/git/worktrees/worktree-removal.js";
import { worktreeLayout } from "../../infrastructure/git/worktrees/worktree-layout.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { packageManagerExecutable, run } from "../../infrastructure/process/run-process.js";

const REBUILD_TIMEOUT_MS = 300_000;

export type WaveIntegrationAdapterDeps = {
  projectRoot: string;
  /** `<repo>/AG` — task bucket'ai lieka `AG/tasks/<bucket>`. */
  agRoot: string;
  taskStore: TaskStateStorePort;
  leaseStore: WorkerLeaseStoreDeps;
  readWorkerLeases: () => Promise<WorkerLease[]>;
};

/** Telemetrijos failai, kuriuos dispatch vaikas rašo į savo worktree kopiją (README `vq/logs/`). */
const TELEMETRY_LOG_NAMES = ["context-size.jsonl", "token-usage.jsonl"] as const;

/** Dedup raktas: ts+task_id+attempt_id — ta pati koreliacijos triada, kuria abu žurnalai jau rašomi. */
function telemetryLineKey(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as { ts?: unknown; task_id?: unknown; attempt_id?: unknown };
  if (typeof record.ts !== "string" || typeof record.task_id !== "string") return undefined;
  const attemptId = typeof record.attempt_id === "string" ? record.attempt_id : "";
  return [record.ts, record.task_id, attemptId].join("::");
}

/**
 * Vieno telemetrijos žurnalo eilučių APPEND'inimas iš worktree kopijos į pagrindinio medžio
 * failą, su dedup'u pagal `telemetryLineKey`. Failo vaiko pusėje nesant — `appended: 0` be
 * klaidos; neparsinama eilutė — praleidžiama tyliai (skaičiuojama `skipped`), o ne meta.
 */
async function mergeTelemetryLog(childPath: string, mainPath: string): Promise<{ appended: number; skipped: number }> {
  const childRaw = await nodeFsAdapter.readTextFileIfExists(childPath);
  if (childRaw === undefined) return { appended: 0, skipped: 0 };

  const mainRaw = await nodeFsAdapter.readTextFileIfExists(mainPath);
  const seen = new Set<string>();
  for (const line of (mainRaw ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const key = telemetryLineKey(line);
    if (key !== undefined) seen.add(key);
  }

  const newLines: string[] = [];
  let skipped = 0;
  for (const line of childRaw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const key = telemetryLineKey(line);
    if (key === undefined) {
      skipped += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    newLines.push(line);
  }

  if (newLines.length > 0) {
    await nodeFsAdapter.appendTextFile(mainPath, `${newLines.join("\n")}\n`);
  }
  return { appended: newLines.length, skipped };
}

/** Task'o failas bucket'uose; `undefined`, kai jo niekur nėra. */
async function findTaskFile(agRoot: string, taskId: string): Promise<{ bucket: TaskBucket; file: string } | undefined> {
  for (const bucket of taskBuckets) {
    const dir = taskBucketDir(agRoot, bucket);
    const names = await nodeFsAdapter.listDirectoryIfExists(dir);
    const name = names?.find((entry) => entry.endsWith(".md") && path.basename(entry, ".md") === taskId);
    if (name !== undefined) return { bucket, file: path.join(dir, name) };
  }
  return undefined;
}

export function createWaveIntegrationAdapters(deps: WaveIntegrationAdapterDeps): {
  resolveWorktreeLayout: (identity: WorktreeIdentity) => WorktreeLayoutView;
  locateTask: (taskId: string) => Promise<TaskLocation>;
  resolvePrimaryHead: () => Promise<string | undefined>;
  integrateBranch: (input: { branch: string; task_id: string }) => Promise<BranchIntegrationOutcome>;
  integrationTouchedSrc: (input: { before?: string | undefined; after: string }) => Promise<boolean>;
  rebuildDist: () => Promise<{ ok: boolean; detail: string }>;
  pushPrimaryBranch: () => Promise<{ ok: boolean; branch?: string; detail?: string }>;
  relocateTask: (taskId: string, bucket: "done" | "human-review") => Promise<TaskRelocation>;
  restoreDoneCopy: (input: { taskId: string; preMergeHead: string | undefined }) => Promise<DoneCopyRestoreOutcome>;
  collectWorktreeTelemetry: (input: { worktreePath: string; task_id: string }) => Promise<{ appended: number; detail: string }>;
  cleanupWorktree: (input: { identity: WorktreeIdentity; lease: WorkerLease; branch: string }) => Promise<WorktreeCleanupOutcome>;
  releaseLease: (leaseId: string) => Promise<LeaseReleaseOutcome>;
} {
  return {
    resolveWorktreeLayout(identity) {
      const layout = worktreeLayout(deps.projectRoot, identity);
      return { relativePath: layout.relative_path, branch: layout.branch };
    },

    async locateTask(taskId) {
      const found = await findTaskFile(deps.agRoot, taskId);
      if (found === undefined) return "absent";
      if (isTerminalBucket(found.bucket)) return "terminal-bucket";
      return found.bucket === "queue" || found.bucket === "active" ? found.bucket : "unknown";
    },

    resolvePrimaryHead: () => gitResolveCommit("HEAD", deps.projectRoot),

    async integrateBranch(input) {
      const merged = await integrateWorktreeBranch({
        projectRoot: deps.projectRoot,
        branch: input.branch,
        taskId: input.task_id,
      });
      switch (merged.status) {
        case "integrated":
          return { status: "integrated", mode: merged.mode, head: merged.head };
        // Pakartotinis kvietimas po restart'o: darbas jau medyje. `head` lieka tas pats, tad
        // `dist` diff'as savaime tuščias — perstatymo klausimas išsisprendžia be atskiros šakos.
        case "already-integrated":
          return { status: "integrated", mode: "already-integrated", head: merged.head };
        case "absent":
          return { status: "absent" };
        case "conflict":
          return { status: "conflict", paths: merged.paths };
        case "refused":
          return { status: "refused", reason: merged.reason, detail: merged.detail };
        default:
          return { status: "infrastructure", message: merged.message };
      }
    },

    integrationTouchedSrc: (input) =>
      integrationTouchedOrchestratorSrc({
        projectRoot: deps.projectRoot,
        ...(input.before === undefined ? {} : { before: input.before }),
        after: input.after,
      }),

    async rebuildDist() {
      // `packageManagerExecutable` BŪTINAS: plikas "pnpm" Windows'e su shell:false duoda ENOENT
      // (run-process .cmd kelią per cmd.exe įjungia tik komandai, kuri BAIGIASI .cmd) — 2026-09-01
      // pirmoji reali integracija (099) sulietą kodą paliko be dist perstatymo ir parkavo done task'ą.
      const result = await run(packageManagerExecutable("pnpm"), ["build"], { cwd: deps.projectRoot, timeoutMs: REBUILD_TIMEOUT_MS });
      return result.code === 0
        ? { ok: true, detail: "" }
        : { ok: false, detail: (result.stderr === "" ? result.stdout : result.stderr).trim() };
    },

    pushPrimaryBranch: () => pushPrimaryBranch(deps.projectRoot),

    async relocateTask(taskId, bucket) {
      const found = await findTaskFile(deps.agRoot, taskId);
      if (found === undefined) return "absent";
      if (found.bucket === bucket) return "already";
      // Jau užbaigtas darbas į `done` NEPERKELIAMAS antrą kartą: `human-review` yra terminalinis
      // bucket'as, ir jo perrašymas į `done` panaikintų žmogaus sprendimą.
      if (bucket === "done" && isTerminalBucket(found.bucket)) return "kept";
      await finishTaskInBucket(deps.taskStore, deps.agRoot, found.file, bucket, path.basename(found.file));
      return "moved";
    },

    async restoreDoneCopy(input) {
      const target = path.join(taskBucketDir(deps.agRoot, "done"), `${input.taskId}.md`);
      if (await nodeFsAdapter.exists(target)) return { ok: true, source: `already:${target}` };
      // Du ref'ai: prieš suliejimą buvęs HEAD ir `HEAD^`. Antrasis reikalingas tada, kai HEAD'o
      // išspręsti nepavyko — be jo vienintelė turinio kopija liktų neprieinama.
      const refs = [...new Set([input.preMergeHead, "HEAD^"])].filter((ref): ref is string => ref !== undefined && ref !== "");
      for (const ref of refs) {
        for (const bucket of taskBuckets) {
          const relPath = `AG/tasks/${bucket}/${input.taskId}.md`;
          const shown = await run("git", ["show", `${ref}:${relPath}`], { cwd: deps.projectRoot, timeoutMs: 30_000 });
          if (shown.code !== 0 || shown.stdout.trim() === "") continue;
          await nodeFsAdapter.writeTextFileAtomic(target, shown.stdout);
          return { ok: true, source: `${ref}:${relPath}` };
        }
      }
      return { ok: false, detail: `task failo turinio nėra git istorijoje (ref'ai: ${refs.join(", ")})` };
    },

    async collectWorktreeTelemetry(input) {
      try {
        const worktreeLogsDir = path.join(deps.projectRoot, input.worktreePath, "vq", "logs");
        const mainLogsDir = path.join(deps.projectRoot, "vq", "logs");
        let appended = 0;
        const details: string[] = [];
        for (const name of TELEMETRY_LOG_NAMES) {
          const result = await mergeTelemetryLog(path.join(worktreeLogsDir, name), path.join(mainLogsDir, name));
          appended += result.appended;
          if (result.skipped > 0) details.push(`${name}: ${result.skipped} neparsinama eilutė(s) praleista`);
        }
        return { appended, detail: details.join("; ") };
      } catch (error) {
        return { appended: 0, detail: `KLAIDA: ${error instanceof Error ? error.message : String(error)}` };
      }
    },

    async cleanupWorktree(input) {
      const removed = await removeTaskWorktree({
        projectRoot: deps.projectRoot,
        identity: input.identity,
        claim: leaseClaimOf(input.lease),
        leases: await deps.readWorkerLeases(),
      });
      if (removed.status !== "removed" && removed.status !== "absent") {
        // Šaka NETRINAMA, kai kopija liko: ji yra vienintelis kelias prie ten likusio darbo.
        return {
          worktree: removed.status,
          branch: "skipped",
          detail:
            removed.status === "infrastructure"
              ? removed.message
              : removed.status === "forbidden"
                ? removed.reason
                : removed.reasons.join(", "),
        };
      }

      const deleted = await deleteWorktreeBranch({ projectRoot: deps.projectRoot, branch: input.branch });
      return {
        worktree: removed.status,
        branch: deleted.status,
        detail: deleted.status === "infrastructure" ? deleted.message : deleted.status === "unmerged" ? deleted.detail : "",
      };
    },

    async releaseLease(leaseId) {
      const lease = (await deps.readWorkerLeases()).find((entry) => entry.lease_id === leaseId);
      if (lease === undefined) return "absent";
      if (lease.status !== "held") return "already-released";
      try {
        const released = await releaseWorkerLease({
          deps: deps.leaseStore,
          projectRoot: deps.projectRoot,
          claim: leaseClaimOf(lease),
          workerId: lease.worker_id,
        });
        return released.status === "ok" ? "released" : "denied";
      } catch {
        // Atlaisvinimo nesėkmė integracijos NEATŠAUKIA: darbas jau medyje, o lease pasibaigs
        // pats. Vardas („failed") lieka žurnale.
        return "failed";
      }
    },
  };
}
