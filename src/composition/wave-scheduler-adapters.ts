// Bangos planuoklio adapteriai (manual DI, LAY-2): eilės skaitymas, task'o vieta, priimto darbo
// įrodymas, ledger'io dublikatas ir aprūpinimo git pusė.
//
// Planuoklio portai VISI privalomi (žr. `wave-scheduler-contract`), tad būtent čia gyvena
// vienintelis kelias iš jo sprendimų į diską ir git. Kiekvienas adapteris laikosi tos pačios
// taisyklės: nežinia NĖRA teigiamas atsakymas. Neperskaityta eilė, nerastas task'as ar
// neprieinamas git medis grąžina „nėra", o ne „yra" — planuoklis tada dirba mažiau, o ne
// klaidingai.

import path from "node:path";
import { readTaskDependencyMetadata } from "../application/task-execution/task-graph-import.js";
import { taskBucketDir } from "../application/task-execution/bucket-transition.js";
import { taskLedgerEntrySeenBefore } from "../application/task-execution/task-ledger-rules.js";
import type { SchedulableTask } from "../application/scheduling/schedule-next-wave.js";
import type { ResumeTaskLocation } from "../application/scheduling/resume-run.js";
import type { WorktreeProvisionOutcome, WaveWorktreePort } from "../application/scheduling/wave-provisioning.js";
import { loadWorktreePolicy } from "../application/scheduling/worktree-policy.js";
import { isTerminalBucket, taskBuckets, type TaskBucket } from "../domain/tasks/index.js";
import { isGitRepository } from "../infrastructure/git/git-client.js";
import { taskCommittedProductWorkSha } from "../infrastructure/git/work-evidence.js";
import { createTaskWorktree } from "../infrastructure/git/worktrees/worktree-provision.js";
import { worktreeRootIsIgnored } from "../infrastructure/git/worktrees/worktree-layout.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import type { AttemptResolutionPort } from "../infrastructure/state/attempt-resolution.js";
import { sha256Hex } from "../shared/hash.js";
import { taskLedgerStore } from "./node-adapters.js";

/** Bucket'ai, kuriuose gulintis task'as reiškia NUTRŪKUSĮ, o ne užbaigtą darbą. */
const RESUMABLE_BUCKETS: readonly TaskBucket[] = ["active", "delegated", "error"];

export type WaveInputAdapterDeps = {
  projectRoot: string;
  agRoot: string;
  runtimeRoot: string;
  resolution: AttemptResolutionPort;
};

/** Markdown failai bucket'e; nesantis katalogas yra atsakymas, ne klaida. */
async function bucketFiles(agRoot: string, bucket: TaskBucket): Promise<string[]> {
  const dir = taskBucketDir(agRoot, bucket);
  const names = (await nodeFsAdapter.listDirectoryIfExists(dir)) ?? [];
  return names.filter((name) => name.endsWith(".md")).map((name) => path.join(dir, name));
}

/** Eilės task'ai su priklausomybėmis — planuoklio įvestis. */
export async function readQueueSchedulableTasks(deps: WaveInputAdapterDeps): Promise<SchedulableTask[]> {
  const metadata = await readTaskDependencyMetadata({
    listTasksInBucket: async (bucket) => {
      const entries: { file: string; text: string }[] = [];
      for (const file of await bucketFiles(deps.agRoot, bucket)) {
        const text = await nodeFsAdapter.readTextFileIfExists(file);
        if (text === undefined) continue;
        // Kelias saugomas REPO-RELIATYVUS: planas keliauja į snapshot'ą ir įvykius, o absoliutus
        // kelias juose reikštų, kad tas pats planas skirtingose mašinose atrodo skirtingai.
        entries.push({ file: path.relative(deps.projectRoot, file).split(path.sep).join("/"), text });
      }
      return entries;
    },
  });
  return metadata.map((task) => ({ task_id: task.task_id, file: task.file, blocked_by: task.blocked_by }));
}

/** Kur task'as guli DABAR. Vienas skenavimas per visus bucket'us. */
export async function locateTaskBucket(deps: WaveInputAdapterDeps, taskId: string): Promise<ResumeTaskLocation> {
  for (const bucket of taskBuckets) {
    const found = (await bucketFiles(deps.agRoot, bucket)).some((file) => path.basename(file, ".md") === taskId);
    if (!found) continue;
    if (bucket === "queue") return "queue";
    return RESUMABLE_BUCKETS.includes(bucket) ? "resumable-bucket" : isTerminalBucket(bucket) ? "terminal-bucket" : "resumable-bucket";
  }
  return "absent";
}

/**
 * Ar task'o darbas jau PRIIMTAS (commit'as pasiekiamas iš HEAD).
 *
 * Ne git medyje atsakymas yra `false`: „įrodymo nėra" reiškia, kad darbas kartojamas — tai
 * saugesnė pusė nei praleisti darbą, kurio niekas nepadarė.
 */
export async function taskHasAcceptedWork(deps: WaveInputAdapterDeps, taskId: string): Promise<boolean> {
  if (!(await isGitRepository(deps.projectRoot))) return false;
  return (
    (await taskCommittedProductWorkSha({ projectRoot: deps.projectRoot, taskId, resolution: deps.resolution })) !== undefined
  );
}

/**
 * Ar ledger'is šį task'ą jau matė TUO PAČIU turiniu.
 *
 * Atspaudas skaičiuojamas TA PAČIA funkcija (`sha256Hex` ant failo baitų), kuria jį rašo
 * koordinatorius: bet koks kitas receptas duotų amžiną „ne dublikatas", nes reikšmės niekada
 * nesutaptų. Neperskaitytas ar sugadintas ledger'is irgi grąžina `false` — dublikato teiginys be
 * įrodymo atimtų iš task'o bandymą, kurio jis niekada neturėjo.
 */
export async function ledgerDuplicate(deps: WaveInputAdapterDeps, taskId: string, absoluteTaskFile: string): Promise<boolean> {
  const entry = (await taskLedgerStore(deps.runtimeRoot).read())[taskId];
  if (!(await nodeFsAdapter.exists(absoluteTaskFile))) return taskLedgerEntrySeenBefore(entry);
  return taskLedgerEntrySeenBefore(entry, sha256Hex(await nodeFsAdapter.readFileBytes(absoluteTaskFile)));
}

/** Aprūpinimo git pusė: politika, gitignore ir darbo kopijos kūrimas. */
export function waveWorktreePort(deps: { projectRoot: string; agRoot: string }): WaveWorktreePort {
  return {
    policyEnabled: async () => {
      const policy = await loadWorktreePolicy(
        { readTextFileIfExists: (file) => nodeFsAdapter.readTextFileIfExists(file) },
        path.join(deps.agRoot, "config", "worktree-policy.json"),
      );
      return policy.enabled;
    },
    rootIsIgnored: () => worktreeRootIsIgnored(deps.projectRoot),
    create: async ({ identity, lease }): Promise<WorktreeProvisionOutcome> => {
      const created = await createTaskWorktree({
        projectRoot: deps.projectRoot,
        identity,
        lease,
        baseRef: "HEAD",
      });
      switch (created.status) {
        case "created":
        case "reused":
          return { status: created.status, relativePath: created.layout.relative_path };
        case "quarantined":
          return { status: "quarantined", reason: created.reasons.join(", ") };
        default:
          return { status: "infrastructure", message: created.message };
      }
    },
  };
}
