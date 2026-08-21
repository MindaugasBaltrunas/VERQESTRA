// `github-pr` CLI adapteris (etalonas: interfaces/cli/github-pr/index.ts): surenka task'o
// santrauką, suformuoja PR pavadinimą bei tekstą ir — tik praėjus vartus — sukuria PR.
//
// Trys vartai, ir visi trys turi praleisti, kad įvyktų išorinis veiksmas: git automatikos
// politika (`pr_after_successful_task`), aiškus `--create` (arba politika, kuri jo
// nereikalauja) ir pačios GitHub politikos `enabled`. Numatytoji būsena — dry run: tekstas
// sugeneruojamas ir įrašomas į rezultato failą, bet niekas neišeina į tinklą.
//
// Rezultatas rašomas VISADA (ir dry run atveju): operatorius turi matyti, ką komanda BŪTŲ
// pateikusi, dar prieš įjungdamas automatiką.

import path from "node:path";
import {
  loadGitAutomationPolicy,
  type GitAutomationPolicy,
} from "../../../application/policy-governance/git-automation-policy.js";
import type { PolicyConfigFileSystemPort } from "../../../application/policy-governance/ports.js";
import { consoleCliIo, type CliIo } from "../registry.js";

/** Politikos forma tokia, kokia ateina iš konfigo; normalizaciją daro adapteris. */
export type GitHubPrPolicyInput = {
  enabled?: boolean;
  owner?: string;
  repo?: string;
  base?: string;
  head?: string;
  draft?: boolean;
  labels?: string[];
};

export type GitHubPrOutcome =
  | { status: "created"; number: number; url: string }
  | { status: "disabled" | "invalid-config"; message: string };

export type GitHubPrPorts = {
  policyFs: PolicyConfigFileSystemPort;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
  /** Politikos normalizacija + vartai + tinklo kvietimas (infrastructure pusė). */
  createPullRequest(input: { policy: GitHubPrPolicyInput; title: string; body: string }): Promise<GitHubPrOutcome>;
};

export type GitHubPrDeps = {
  ports: GitHubPrPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: CliIo;
};

export type GitHubPrCommandResult = GitHubPrOutcome & {
  title: string;
  body: string;
  result_path: string;
};

/** Būsenos failai, kurių santrauka patenka į PR tekstą (etalono sąrašas 1:1). */
const RESULT_FILES = [
  "quality-gates-status.json",
  "spec-drift-result.json",
  "security-verify-result.json",
  "token-budget-status.json",
] as const;

export type PullRequestSummary = {
  taskId: string;
  taskFile: string;
  projectStatus: string;
  checks: string[];
  results: Record<string, string>;
};

export function buildPullRequestTitle(summary: PullRequestSummary): string {
  return `AG task ${summary.taskId}`;
}

export function buildPullRequestBody(summary: PullRequestSummary): string {
  const checks =
    summary.checks.length > 0 ? summary.checks.map((check) => `- ${check}`).join("\n") : "- No checks recorded.";
  const results = Object.entries(summary.results)
    .map(([file, status]) => `- ${file}: ${status}`)
    .join("\n");

  return [
    "## Summary",
    "",
    summary.projectStatus,
    "",
    "## Task",
    "",
    `- Task id: ${summary.taskId}`,
    `- Task file: ${summary.taskFile}`,
    "",
    "## Checks",
    "",
    checks,
    "",
    "## Result files",
    "",
    results,
    "",
  ].join("\n");
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `missing` | `present` | konkretus statusas — pakankamai, kad recenzentas žinotų, ko ieškoti. */
function summarizeResultFile(raw: string | undefined): string {
  const parsed = parseJsonObject(raw);
  if (Object.keys(parsed).length === 0) return "missing";
  const status = parsed["status"] ?? parsed["passed"] ?? parsed["result"] ?? parsed["lastUpdated"];
  if (status === undefined || status === null) return "present";
  return typeof status === "string" ? status : JSON.stringify(status);
}

async function readTrimmed(ports: GitHubPrPorts, absolutePath: string): Promise<string> {
  return ((await ports.readTextFileIfExists(absolutePath)) ?? "").trim();
}

async function buildPullRequestSummary(
  ports: GitHubPrPorts,
  runtimeRoot: string,
): Promise<PullRequestSummary> {
  const statePath = (...segments: string[]): string => path.join(runtimeRoot, "state", ...segments);

  const taskId = (await readTrimmed(ports, statePath("current-task-id"))) || "unknown-task";
  const taskFile = (await readTrimmed(ports, statePath("current-task-file"))) || "unknown";
  const projectStatus =
    (await readTrimmed(ports, path.join(runtimeRoot, "project", "status.md"))) || "No project status file found.";

  const quality = parseJsonObject(await ports.readTextFileIfExists(statePath("quality-gates-status.json")));
  const commands = quality["commands"];
  const checks = Array.isArray(commands)
    ? commands.filter((command): command is string => typeof command === "string" && command.trim().length > 0)
    : [];

  const results = Object.fromEntries(
    await Promise.all(
      RESULT_FILES.map(
        async (file) => [file, summarizeResultFile(await ports.readTextFileIfExists(statePath(file)))] as const,
      ),
    ),
  );

  return { taskId, taskFile, projectStatus, checks, results };
}

async function loadPrPolicy(ports: GitHubPrPorts, runtimeRoot: string): Promise<GitHubPrPolicyInput> {
  // Kaip ir issue importe: neperskaitomas konfigas reiškia IŠJUNGTĄ automatiką.
  const raw = await ports.readTextFileIfExists(path.join(runtimeRoot, "config", "github-policy.json"));
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw) as GitHubPrPolicyInput;
  } catch {
    return {};
  }
}

export async function githubPr(deps: GitHubPrDeps, args: string[] = []): Promise<GitHubPrCommandResult> {
  const unknown = args.filter((arg) => arg !== "--create");
  if (unknown.length > 0) throw new Error(`Unknown github-pr option: ${unknown.join(" ")}`);

  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");

  const automationPolicy: GitAutomationPolicy = await loadGitAutomationPolicy(deps.ports.policyFs, runtimeRoot);
  const policy = await loadPrPolicy(deps.ports, runtimeRoot);
  const summary = await buildPullRequestSummary(deps.ports, runtimeRoot);
  const title = buildPullRequestTitle(summary);
  const body = buildPullRequestBody(summary);

  const shouldCreate = args.includes("--create") || (!automationPolicy.pr_requires_create_flag && policy.enabled === true);
  const outcome: GitHubPrOutcome = !automationPolicy.pr_after_successful_task
    ? { status: "disabled", message: "GitHub PR automation is disabled by AG git automation policy." }
    : shouldCreate
      ? await deps.ports.createPullRequest({ policy, title, body })
      : {
          status: "disabled",
          message: "Dry run only. Pass --create and enable vq/config/github-policy.json to create a PR.",
        };

  const resultPath = path.join(runtimeRoot, "state", "github-pr-result.json");
  const commandResult: GitHubPrCommandResult = {
    ...outcome,
    title,
    body,
    result_path: path.relative(root, resultPath).replace(/\\/g, "/"),
  };
  await deps.ports.makeDirectory(path.dirname(resultPath));
  await deps.ports.writeTextFile(resultPath, `${JSON.stringify(commandResult, null, 2)}\n`);
  return commandResult;
}

export async function githubPrCommand(deps: GitHubPrDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await githubPr(deps, args);
    io.out(`github-pr: ${result.status}`);
    io.out(`title: ${result.title}`);
    if (result.status === "created") {
      io.out(`url: ${result.url}`);
    } else {
      io.out(`message: ${result.message}`);
    }
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
