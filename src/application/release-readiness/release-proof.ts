// release-readiness use case (etalono release-proof.ts, WBR VQ-305): commit'inamas,
// sanitizuotas release įrodymo artefaktas — išvedamas TIK iš dabartinių vartų išvesčių
// (niekada iš žalių vq/state vidų), tad peržiūrėtojas gali patikrinti, kuris commit'as
// praėjo galutinius vartus, nepasitikėdamas ignoruojama lokalia būsena. FS/git — per portą.
import path from "node:path";
import { taskBuckets, type TaskBucket } from "../../domain/tasks/buckets.js";

export type ReleaseProofFinalAuditStatus = "complete" | "not_complete";
export type ReleaseProofConvergeStatus = "converged" | "issues";

export type ReleaseProofTaskBucketCounts = Record<TaskBucket, number>;

export type ReleaseProofData = {
  git_sha: string | undefined;
  generated_at: string;
  final_audit_status: ReleaseProofFinalAuditStatus;
  converge_status: ReleaseProofConvergeStatus;
  release_check_status: string;
  architecture_boundary_status: string;
  /** BENCH-12 įrodymo eilutė. Optional: seni proof'ai jos neturi; generatorius visada rašo. */
  benchmark_evidence_status?: string;
  /** Compression vartų eilutė. Optional dėl tos pačios priežasties. */
  compression_quality_status?: string;
  task_bucket_counts: ReleaseProofTaskBucketCounts;
  release_notes_path?: string;
};

export type GenerateReleaseProofOptions = {
  finalAuditStatus: ReleaseProofFinalAuditStatus;
  convergeStatus: ReleaseProofConvergeStatus;
  releaseCheckStatus: string;
  architectureBoundaryStatus?: string;
  benchmarkEvidenceStatus?: string;
  compressionQualityStatus?: string;
  releaseNotesPath?: string;
  now?: Date;
};

export type ReleaseProofWriteResult = {
  data: ReleaseProofData;
  summary_path: string;
  markdown_path: string;
};

export type ReleaseProofPorts = {
  gitHead(): Promise<string | undefined>;
  /** Numeruotų task failų kiekis bucket'e (adapteris naudoja domain taskNumberFromFilename). */
  countNumberedTasks(bucket: TaskBucket): Promise<number>;
  writeSummary(data: ReleaseProofData): Promise<void>;
  writeMarkdown(text: string): Promise<void>;
  readSummary(): Promise<ReleaseProofData | undefined>;
};

/** `vq/project/final-audit-summary.json` — commit'inamas įrodymo JSON. */
export function releaseProofSummaryPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "project", "final-audit-summary.json");
}

/** `vq/project/final-release-proof.md` — žmogui skirtas įrodymo dokumentas. */
export function releaseProofMarkdownPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "project", "final-release-proof.md");
}

async function countTaskBuckets(ports: ReleaseProofPorts): Promise<ReleaseProofTaskBucketCounts> {
  const counts = {} as ReleaseProofTaskBucketCounts;
  for (const bucket of taskBuckets) {
    counts[bucket] = await ports.countNumberedTasks(bucket);
  }
  return counts;
}

export function renderReleaseProofMarkdown(data: ReleaseProofData): string {
  const bucketLines = taskBuckets.map((bucket) => `- ${bucket}: ${data.task_bucket_counts[bucket]}`).join("\n");
  return [
    "# AG Final Release Proof",
    "",
    "Committed, sanitized evidence of the commit that last passed final gates. Regenerated",
    "deterministically by `verqestra final-audit` from current gate outputs — it does not commit any",
    "raw runtime state internals.",
    "",
    `Generated: ${data.generated_at}`,
    `Git SHA: ${data.git_sha ?? "unknown"}`,
    "",
    "## Gate status",
    "",
    `- final-audit: ${data.final_audit_status}`,
    `- converge: ${data.converge_status}`,
    `- release-check: ${data.release_check_status}`,
    `- architecture-boundary: ${data.architecture_boundary_status}`,
    `- benchmark-evidence: ${data.benchmark_evidence_status ?? "not_checked"}`,
    `- compression-quality: ${data.compression_quality_status ?? "not_checked"}`,
    "",
    "## Task bucket counts",
    "",
    bucketLines,
    "",
    "## Release notes",
    "",
    data.release_notes_path ? `Path: ${data.release_notes_path}` : "Not generated this run.",
    "",
  ].join("\n");
}

export async function generateReleaseProof(
  ports: ReleaseProofPorts,
  options: GenerateReleaseProofOptions,
): Promise<ReleaseProofWriteResult> {
  const now = options.now ?? new Date();

  const [gitSha, taskBucketCounts] = await Promise.all([ports.gitHead(), countTaskBuckets(ports)]);

  const data: ReleaseProofData = {
    git_sha: gitSha,
    generated_at: now.toISOString(),
    final_audit_status: options.finalAuditStatus,
    converge_status: options.convergeStatus,
    release_check_status: options.releaseCheckStatus,
    architecture_boundary_status: options.architectureBoundaryStatus ?? "not_checked",
    benchmark_evidence_status: options.benchmarkEvidenceStatus ?? "not_checked",
    compression_quality_status: options.compressionQualityStatus ?? "not_checked",
    task_bucket_counts: taskBucketCounts,
    ...(options.releaseNotesPath === undefined ? {} : { release_notes_path: options.releaseNotesPath }),
  };

  await ports.writeSummary(data);
  await ports.writeMarkdown(renderReleaseProofMarkdown(data));

  return {
    data,
    summary_path: "vq/project/final-audit-summary.json",
    markdown_path: "vq/project/final-release-proof.md",
  };
}

export type ReleaseProofFreshness = {
  stale: boolean;
  reason?: string;
  proof?: ReleaseProofData;
};

/**
 * Stale-proof aptikimas: commit'intas proof'as patikimas tik jei egzistuoja, fiksavo
 * `complete` final audit ir jo git SHA sutampa su dabartiniu HEAD. `queue` yra vienintelis
 * git'o sekamas bucket'as (kiti — gitignore'inta lokali runtime būsena): sutampantis SHA
 * įrodo tik paskutinį COMMIT'ą, o ne necommit'intus queue pakeitimus — be šios patikros
 * tuščioje eilėje užfiksuotas proof'as liktų „šviežias" amžinai, kol nauji taskai kaupiasi.
 */
export async function checkReleaseProofFreshness(
  ports: ReleaseProofPorts,
  currentGitSha: string | undefined,
): Promise<ReleaseProofFreshness> {
  const proof = await ports.readSummary();
  if (!proof) {
    return { stale: true, reason: "final-audit-summary.json is missing" };
  }
  if (proof.final_audit_status !== "complete") {
    return { stale: true, reason: "recorded final_audit_status is not complete", proof };
  }
  if (currentGitSha !== undefined && proof.git_sha !== currentGitSha) {
    return { stale: true, reason: "recorded git_sha does not match current HEAD", proof };
  }
  const recordedQueueCount = proof.task_bucket_counts?.queue;
  if (recordedQueueCount !== undefined) {
    const currentQueueCount = await ports.countNumberedTasks("queue");
    if (currentQueueCount !== recordedQueueCount) {
      return {
        stale: true,
        reason: `recorded queue task count (${recordedQueueCount}) does not match current queue count (${currentQueueCount})`,
        proof,
      };
    }
  }
  return { stale: false, proof };
}
