// Konvergencijos patikra: ar suplanuoti spec task'ai turi failus eilėje, ar neliko
// nebaigto darbo bucket'uose ir ar status išvestys nepasenusios. Elgesio etalonas: AG_loop
// orchestrator/quality/converge.ts. VERQESTRA skirtumai: IO per ConvergePorts; openspec —
// AG/openspec, legacy spec — AG/spec, task bucket'ai — AG/tasks, status failai —
// vq/project. DUP-02: planned-task slug'ai eina per domain/tasks `taskSlug`; DUP-10:
// AG/spec ir AG/openspec abu eina per bendrą `parseSpecTaskLines`.

import path from "node:path";
import { taskSlug, taskSlugCandidates } from "../../domain/tasks/identity.js";
import { taskBuckets, type TaskBucket } from "../../domain/tasks/buckets.js";
import { parseSpecTaskLines } from "../task-planning/spec-task-lines.js";

const incompleteBuckets = ["active", "delegated", "error", "failed", "human-review"] as const;
const statusFiles = ["project/status.md", "project/next-tasks.md"] as const;

type ActiveSpec = { id: string; changeDir: string; provider: "AG/spec" | "AG/openspec" };
/** `slug` — kanoninis (ataskaitoms); `slugs` — jis plius senasis, TIK atpažinimui. */
type PlannedTask = { title: string; slug: string; slugs: string[]; queueId?: string; complete?: boolean };

export type ConvergeIssue = {
  kind: "missing-task" | "incomplete-work" | "stale-status";
  message: string;
  ref: string;
};

export type ConvergeResult = {
  status: "converged" | "issues";
  active_spec: string | undefined;
  planned_tasks: string[];
  task_files: Record<TaskBucket, string[]>;
  issues: ConvergeIssue[];
};

export type ConvergePorts = {
  /** Failo tekstas arba `undefined`, kai failo nėra. */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** Poaplankių vardai; `[]` kai katalogo nėra. */
  listSubdirectories(absoluteDir: string): Promise<string[]>;
  /** Failų vardai (ne katalogai); `[]` kai katalogo nėra. */
  listFiles(absoluteDir: string): Promise<string[]>;
  /** mtime (ms) arba `undefined`, kai failo nėra. */
  fileMtimeMs(absolutePath: string): Promise<number | undefined>;
};

export type ConvergeOptions = {
  projectRoot?: string;
  /** vq runtime šaknis (status failams). Default: <projectRoot>/vq. */
  runtimeRoot?: string;
};

export async function converge(ports: ConvergePorts, options: ConvergeOptions = {}): Promise<ConvergeResult> {
  const root = path.resolve(options.projectRoot ?? process.cwd());
  const runtimeRoot = options.runtimeRoot ?? path.join(root, "vq");
  const agRoot = path.join(root, "AG");

  const activeSpecs = await findActiveSpecs(ports, agRoot);
  const plannedTasks = (await Promise.all(activeSpecs.map((spec) => readPlannedTasks(ports, spec)))).flat();
  const taskFiles = await readTaskFiles(ports, agRoot);
  const issues: ConvergeIssue[] = [];

  for (const task of plannedTasks) {
    if (task.complete) continue;
    if (!hasTaskFile(task, taskFiles)) {
      issues.push({ kind: "missing-task", ref: task.slug, message: `planned task missing from task folders: ${task.title}` });
    }
  }

  for (const bucket of incompleteBuckets) {
    for (const file of taskFiles[bucket]) {
      issues.push({ kind: "incomplete-work", ref: `${bucket}/${file}`, message: `task remains in ${bucket}: ${file}` });
    }
  }

  for (const file of await detectStaleStatusFiles(ports, runtimeRoot, activeSpecs)) {
    issues.push({ kind: "stale-status", ref: file, message: `status output is missing or stale: ${file}` });
  }

  issues.sort((a, b) => a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref));
  return {
    status: issues.length === 0 ? "converged" : "issues",
    active_spec: activeSpecs.map((spec) => `${spec.provider}:${spec.id}`).sort().join(",") || undefined,
    planned_tasks: plannedTasks.map((task) => task.slug).sort(),
    task_files: taskFiles,
    issues,
  };
}

async function findActiveSpecs(ports: ConvergePorts, agRoot: string): Promise<ActiveSpec[]> {
  return [...(await findLegacyActiveSpecs(ports, agRoot)), ...(await findOpenSpecChanges(ports, agRoot))].sort((a, b) =>
    `${a.provider}:${a.id}`.localeCompare(`${b.provider}:${b.id}`),
  );
}

async function findLegacyActiveSpecs(ports: ConvergePorts, agRoot: string): Promise<ActiveSpec[]> {
  const changesDir = path.join(agRoot, "spec", "changes");
  const entries = await ports.listSubdirectories(changesDir);
  const specs: ActiveSpec[] = [];
  for (const name of [...entries].sort((a, b) => a.localeCompare(b))) {
    const changeDir = path.join(changesDir, name);
    try {
      const raw = await ports.readTextFileIfExists(path.join(changeDir, "spec.json"));
      if (raw === undefined) continue;
      const spec = JSON.parse(raw) as { id?: unknown; status?: unknown };
      if (spec.status === "active") {
        specs.push({ id: typeof spec.id === "string" ? spec.id : name, changeDir, provider: "AG/spec" });
      }
    } catch {
      continue;
    }
  }
  return specs;
}

async function findOpenSpecChanges(ports: ConvergePorts, agRoot: string): Promise<ActiveSpec[]> {
  const changesDir = path.join(agRoot, "openspec", "changes");
  const entries = await ports.listSubdirectories(changesDir);
  return entries
    .filter((name) => name !== "archive" && name !== "_template")
    .map((name) => ({ id: name, changeDir: path.join(changesDir, name), provider: "AG/openspec" as const }));
}

async function readPlannedTasks(ports: ConvergePorts, spec: ActiveSpec): Promise<PlannedTask[]> {
  const tasksText = (await ports.readTextFileIfExists(path.join(spec.changeDir, "tasks.md"))) ?? "";
  return parseSpecTaskLines(tasksText, { requireCheckbox: spec.provider === "AG/openspec" }).map((task) => {
    const queueId = task.title.match(/\bqueue\s+(\d+[a-z]?)\b/i)?.[1]?.toLowerCase();
    return {
      title: task.title,
      slug: taskSlug(task.title),
      slugs: taskSlugCandidates(task.title),
      ...(queueId === undefined ? {} : { queueId }),
      ...(task.complete === undefined ? {} : { complete: task.complete }),
    };
  });
}

async function readTaskFiles(ports: ConvergePorts, agRoot: string): Promise<Record<TaskBucket, string[]>> {
  const entries = await Promise.all(
    taskBuckets.map(async (bucket) => {
      const files = await ports.listFiles(path.join(agRoot, "tasks", bucket));
      return [bucket, files.filter((file) => file.endsWith(".md")).sort()] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<TaskBucket, string[]>;
}

// `hasTaskFile` sąmoningai lieka substring (`file.includes(slug)`) match — task failo vardas
// turi papildomą `<NNN>-` prefiksą ir gali būti apkarpytas, tad tikslus lygumas netiktų.
//
// Slug'ų yra DU (2026-08-24): dabartinis, transliteruojantis lietuviškas raides, ir senasis, kuris
// jas išmesdavo. Jau esantys failai sukurti pagal senąjį, ir jų niekas nepervadina, tad
// atpažinimas privalo priimti abu — kitaip `converge` kiekvieną lietuvišką užduotį paskelbtų
// dingusia tą pačią akimirką, kai pasikeitė vardų taisyklė.
function hasTaskFile(task: PlannedTask, taskFiles: Record<TaskBucket, string[]>): boolean {
  return taskBuckets.some((bucket) =>
    taskFiles[bucket].some(
      (file) =>
        (task.queueId !== undefined && file.toLowerCase().startsWith(`${task.queueId}-`)) ||
        task.slugs.some((slug) => file.includes(slug)),
    ),
  );
}

async function detectStaleStatusFiles(
  ports: ConvergePorts,
  runtimeRoot: string,
  activeSpecs: ActiveSpec[],
): Promise<string[]> {
  const latestSourceTime = await latestMtime(ports, activeSpecs.flatMap((spec) => specFiles(spec)));
  const stale: string[] = [];
  for (const file of statusFiles) {
    const statusPath = path.join(runtimeRoot, ...file.split("/"));
    const statusTime = await ports.fileMtimeMs(statusPath);
    if (statusTime === undefined || (latestSourceTime !== undefined && statusTime < latestSourceTime)) stale.push(file);
  }
  return stale.sort();
}

function specFiles(spec: ActiveSpec): string[] {
  return spec.provider === "AG/spec"
    ? [path.join(spec.changeDir, "spec.json"), path.join(spec.changeDir, "tasks.md")]
    : [
        path.join(spec.changeDir, "proposal.md"),
        path.join(spec.changeDir, "design.md"),
        path.join(spec.changeDir, "spec.md"),
        path.join(spec.changeDir, "tasks.md"),
      ];
}

async function latestMtime(ports: ConvergePorts, files: string[]): Promise<number | undefined> {
  const times = await Promise.all(files.map((file) => ports.fileMtimeMs(file)));
  const present = times.filter((time): time is number => time !== undefined);
  return present.length > 0 ? Math.max(...present) : undefined;
}
