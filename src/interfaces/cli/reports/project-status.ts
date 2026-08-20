// `project-status` CLI adapteris (etalonas: interfaces/cli/project-status/index.ts 1:1).
// Rašo `vq/project/status.md` + `vq/project/next-tasks.md` (etalone — AG/project);
// konfigai — vq/config, rezultatų failai — vq/state, architektūros progresas —
// vq/state/architecture; task bucket'ai ir aktyvi spec lieka AG šaknyje. Release proof
// šviežumas — application/release-readiness/release-proof per ReleaseProofPorts,
// git HEAD — per deps.gitHead portą (infrastructure suriša VQ-504).

import path from "node:path";
import {
  checkReleaseProofFreshness,
  type ReleaseProofFreshness,
  type ReleaseProofPorts,
} from "../../../application/release-readiness/release-proof.js";
import { taskBuckets, type TaskBucket } from "../../../application/task-execution/index.js";
import { consoleCliIo, type CliIo } from "../registry.js";

// Buckets other than "queue" a reviewer must also treat as remaining work — mirrors
// FinalAuditResult's pendingBuckets (application/release-readiness/final-audit.ts) so
// next-tasks.md cannot claim "no remaining work" while final-audit would still block.
const otherPendingBuckets = ["active", "delegated", "error", "failed", "human-review"] as const;

const archStatusKeys = ["planned", "ready", "queued", "active", "repairing", "done", "human-review"] as const;
type ArchStatus = (typeof archStatusKeys)[number];
type ArchitectureProgressSummary = { nodes_total: number } & Record<ArchStatus, number>;

const configFiles = [
  "model-policy.json",
  "tool-budget.json",
  "context-budget.json",
  "quality-policy.json",
  "security-policy.json",
  "spec-policy.json",
  "preflight-limits.json",
] as const;
const resultFiles = [
  "quality-gates-status.json",
  "spec-drift-result.json",
  "security-verify-result.json",
  "token-budget-status.json",
  "state-history.json",
] as const;

export type ProjectStatusCommandDeps = {
  fs: {
    readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
    /** Failų vardai kataloge; `[]` kai katalogo nėra. */
    listFiles(absoluteDir: string): Promise<string[]>;
    /** Poaplankių vardai; `[]` kai katalogo nėra. */
    listSubdirectories(absoluteDir: string): Promise<string[]>;
    /** Rašymas su tėvinių katalogų sukūrimu. */
    writeTextFile(absolutePath: string, text: string): Promise<void>;
  };
  releaseProof: ReleaseProofPorts;
  gitHead(): Promise<string | undefined>;
  projectRoot: string;
  /** Numatytoji runtime šaknis — `<projectRoot>/vq`. */
  runtimeRoot?: string;
  io?: CliIo;
};

export type ProjectStatusResult = {
  statusPath: string;
  nextTasksPath: string;
  counts: Record<TaskBucket, number>;
  activeSpec: string | undefined;
  nextTasks: string[];
  otherPending: Partial<Record<(typeof otherPendingBuckets)[number], string[]>>;
  architectureProgress: ArchitectureProgressSummary | null;
  releaseProof: ReleaseProofFreshness;
};

export async function projectStatus(deps: ProjectStatusCommandDeps): Promise<ProjectStatusResult> {
  const root = path.resolve(deps.projectRoot);
  const agRoot = path.join(root, "AG");
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const counts = await readTaskCounts(deps, agRoot);
  const activeSpec = await findActiveSpec(deps, agRoot);
  const nextTasks = await listMarkdown(deps, path.join(agRoot, "tasks", "queue"));
  const otherPending = await readOtherPendingBuckets(deps, agRoot);
  const configStatus = await readConfigStatus(deps, runtimeRoot);
  const recentResults = await readRecentResults(deps, runtimeRoot);
  const architectureProgress = await readArchitectureProgress(deps, runtimeRoot);
  const currentGitSha = await deps.gitHead();
  const releaseProof = await checkReleaseProofFreshness(deps.releaseProof, currentGitSha);

  const statusPath = path.join(runtimeRoot, "project", "status.md");
  const nextTasksPath = path.join(runtimeRoot, "project", "next-tasks.md");
  await deps.fs.writeTextFile(
    statusPath,
    renderStatus({ counts, activeSpec, configStatus, recentResults, architectureProgress, releaseProof }),
  );
  await deps.fs.writeTextFile(nextTasksPath, renderNextTasks(nextTasks, otherPending));

  return {
    statusPath: path.relative(root, statusPath).replace(/\\/g, "/"),
    nextTasksPath: path.relative(root, nextTasksPath).replace(/\\/g, "/"),
    counts,
    activeSpec,
    nextTasks,
    otherPending,
    architectureProgress,
    releaseProof,
  };
}

export async function projectStatusCommand(deps: ProjectStatusCommandDeps, _args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await projectStatus(deps);
    io.out(`project-status: ${result.statusPath}`);
    io.out(`next-tasks: ${result.nextTasksPath}`);
    io.out(`active_spec: ${result.activeSpec ?? "none"}`);
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function listMarkdown(deps: ProjectStatusCommandDeps, dir: string): Promise<string[]> {
  return (await deps.fs.listFiles(dir)).filter((name) => name.endsWith(".md")).sort();
}

async function readTaskCounts(deps: ProjectStatusCommandDeps, agRoot: string): Promise<Record<TaskBucket, number>> {
  const entries = await Promise.all(
    taskBuckets.map(async (bucket) => [bucket, (await listMarkdown(deps, path.join(agRoot, "tasks", bucket))).length] as const),
  );
  return Object.fromEntries(entries) as Record<TaskBucket, number>;
}

async function findActiveSpec(deps: ProjectStatusCommandDeps, agRoot: string): Promise<string | undefined> {
  const changesDir = path.join(agRoot, "spec", "changes");
  const names = await deps.fs.listSubdirectories(changesDir);
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const raw = await deps.fs.readTextFileIfExists(path.join(changesDir, name, "spec.json"));
    if (raw === undefined) continue;
    try {
      const spec = JSON.parse(raw) as { id?: unknown; status?: unknown };
      if (spec.status === "active") {
        return typeof spec.id === "string" && spec.id.length > 0 ? spec.id : name;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

async function readOtherPendingBuckets(
  deps: ProjectStatusCommandDeps,
  agRoot: string,
): Promise<Partial<Record<(typeof otherPendingBuckets)[number], string[]>>> {
  const result: Partial<Record<(typeof otherPendingBuckets)[number], string[]>> = {};
  for (const bucket of otherPendingBuckets) {
    const files = await listMarkdown(deps, path.join(agRoot, "tasks", bucket));
    if (files.length > 0) result[bucket] = files;
  }
  return result;
}

async function readConfigStatus(deps: ProjectStatusCommandDeps, runtimeRoot: string): Promise<Record<string, "present" | "missing">> {
  const entries = await Promise.all(
    configFiles.map(async (file) => {
      const raw = await deps.fs.readTextFileIfExists(path.join(runtimeRoot, "config", file));
      return [file, raw === undefined ? "missing" : "present"] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function readRecentResults(deps: ProjectStatusCommandDeps, runtimeRoot: string): Promise<Record<string, string>> {
  const entries = await Promise.all(
    resultFiles.map(async (file) => {
      const raw = await deps.fs.readTextFileIfExists(path.join(runtimeRoot, "state", file));
      return [file, raw === undefined ? "missing" : summarizeJson(raw)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function readArchitectureProgress(
  deps: ProjectStatusCommandDeps,
  runtimeRoot: string,
): Promise<ArchitectureProgressSummary | null> {
  const raw = await deps.fs.readTextFileIfExists(path.join(runtimeRoot, "state", "architecture", "progress.json"));
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as { nodes?: Record<string, { status?: string }> };
    const nodes = parsed.nodes ?? {};
    const counts = Object.fromEntries(archStatusKeys.map((k) => [k, 0])) as Record<ArchStatus, number>;
    for (const node of Object.values(nodes)) {
      const s = node.status as ArchStatus | undefined;
      if (s && (archStatusKeys as readonly string[]).includes(s)) {
        counts[s]++;
      }
    }
    return { nodes_total: Object.keys(nodes).length, ...counts };
  } catch {
    return null;
  }
}

function summarizeJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | unknown[];
    if (Array.isArray(parsed)) return `array(${parsed.length})`;
    const status = parsed["status"] ?? parsed["passed"] ?? parsed["lastUpdated"];
    if (status === undefined || status === null) return "present";
    return typeof status === "string" ? status : JSON.stringify(status);
  } catch {
    return "invalid-json";
  }
}

function renderStatus(input: {
  counts: Record<TaskBucket, number>;
  activeSpec: string | undefined;
  configStatus: Record<string, string>;
  recentResults: Record<string, string>;
  architectureProgress: ArchitectureProgressSummary | null;
  releaseProof: ReleaseProofFreshness;
}): string {
  const archSection =
    input.architectureProgress === null
      ? "- not initialized"
      : [
          ...archStatusKeys.map((k) => `- ${k}: ${input.architectureProgress![k]}`),
          `- nodes_total: ${input.architectureProgress.nodes_total}`,
        ].join("\n");

  return `# AG Project Status

## Task Folders
${taskBuckets.map((bucket) => `- ${bucket}: ${input.counts[bucket]}`).join("\n")}

## Active Spec
- ${input.activeSpec ?? "none"}

## Config
${Object.entries(input.configStatus).map(([file, status]) => `- ${file}: ${status}`).join("\n")}

## Recent Results
${Object.entries(input.recentResults).map(([file, status]) => `- ${file}: ${status}`).join("\n")}

## Architecture Progress
${archSection}

## Release Proof
${renderReleaseProofSection(input.releaseProof)}
`;
}

// Reflects the committed final-audit-summary.json (release-proof.ts) so status.md
// never claims completion state that the committed evidence artifact does not back up.
function renderReleaseProofSection(releaseProof: ReleaseProofFreshness): string {
  if (releaseProof.stale) {
    const reason = releaseProof.reason ?? "unknown reason";
    if (!releaseProof.proof) {
      return `- status: missing (${reason})`;
    }
    return [
      `- status: stale (${reason})`,
      `- proof generated_at: ${releaseProof.proof.generated_at}`,
      `- proof git_sha: ${releaseProof.proof.git_sha ?? "unknown"}`,
      `- proof final_audit_status: ${releaseProof.proof.final_audit_status}`,
    ].join("\n");
  }
  const proof = releaseProof.proof!;
  return [
    "- status: fresh",
    `- generated_at: ${proof.generated_at}`,
    `- git_sha: ${proof.git_sha ?? "unknown"}`,
    `- final_audit_status: ${proof.final_audit_status}`,
    `- converge_status: ${proof.converge_status}`,
    `- release_check_status: ${proof.release_check_status}`,
  ].join("\n");
}

function renderNextTasks(
  nextTasks: string[],
  otherPending: Partial<Record<(typeof otherPendingBuckets)[number], string[]>>,
): string {
  const queueSection = nextTasks.length === 0 ? "- No queued tasks." : nextTasks.map((task) => `- ${task}`).join("\n");

  const otherEntries = otherPendingBuckets.filter((bucket) => otherPending[bucket]?.length);
  const otherSection =
    otherEntries.length === 0
      ? "- none"
      : otherEntries.map((bucket) => `- ${bucket}: ${otherPending[bucket]!.join(", ")}`).join("\n");

  return `# Next Tasks\n\n${queueSection}\n\n## Other Pending Work\n${otherSection}\n`;
}
