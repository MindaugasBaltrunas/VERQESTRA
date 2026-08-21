// `github-issue-import` CLI adapteris (etalonas: interfaces/cli/github-issue-import/index.ts):
// GitHub issue paverčiamas ČERNOVIKINIU task failu.
//
// Du saugos faktai, atkartoti iš etalono. Pirma, draft'as rašomas į `AG/tasks/pending` —
// katalogą, kurio NĖRA gyvavimo ciklo bucket'uose (queue/active/…), tad kilpa jo niekada
// nepaims: importuotas issue privalo pereiti žmogaus peržiūrą, kol taps vykdoma užduotimi.
// Antra, pats draft'as sąmoningai palieka TODO scope/checks vietas — jos yra tos peržiūros
// darbotvarkė, ne praleista detalė.
//
// VERQESTRA skirtumas: politikos vartai ir tinklo klientas gyvena infrastructure, tad čia
// jie pasiekiami per `GitHubIssueImportPorts` — interfaces sluoksnis infrastructure
// neimportuoja. Be sukonfigūruoto kliento importas neįvyksta: numatytoji būsena — be tinklo.

import path from "node:path";
import { consoleCliIo, type CliIo } from "../registry.js";

/** Struktūrinis issue vaizdas — infrastruktūros `GitHubIssue` jį tenkina. */
export type GitHubIssueView = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
};

/** Politikos forma tokia, kokia ateina iš konfigo; normalizaciją daro adapteris. */
export type GitHubIssueImportPolicyInput = {
  enabled?: boolean;
  owner?: string;
  repo?: string;
};

export type GitHubIssueImportOutcome =
  | { status: "disabled" | "invalid-config" | "invalid-issue"; message: string }
  | { status: "importable"; issue: GitHubIssueView };

export type GitHubIssueImportPorts = {
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
  /** Politikos normalizacija + vartai + (tik praėjus vartus) tinklo kvietimas. */
  importIssue(input: {
    policy: GitHubIssueImportPolicyInput;
    issueNumber: number;
  }): Promise<GitHubIssueImportOutcome>;
  /** Draft teksto renderis — kontraktas gyvena integracijos modulyje, ne čia. */
  renderIssueDraftTask(issue: GitHubIssueView): string;
};

export type GitHubIssueImportDeps = {
  ports: GitHubIssueImportPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`) — github-policy.json vieta. */
  runtimeRoot?: string;
  io?: CliIo;
};

export type GitHubIssueImportCommandResult =
  | { status: "created"; issue_number: number; task_path: string }
  | { status: "disabled" | "invalid-config" | "invalid-issue"; issue_number: number; message: string };

export function parseIssueNumber(args: string[]): number {
  const issueFlag = args.indexOf("--issue");
  if (issueFlag < 0 || issueFlag + 1 >= args.length) {
    throw new Error("github-issue-import requires --issue <number>.");
  }
  const allowed = new Set([issueFlag, issueFlag + 1]);
  const unknown = args.filter((_arg, index) => !allowed.has(index));
  if (unknown.length > 0) {
    throw new Error(`Unknown github-issue-import option: ${unknown.join(" ")}`);
  }
  return Number(args[issueFlag + 1]);
}

/** Failo vardo dalis iš issue pavadinimo; tuščias rezultatas krenta į `imported`. */
export function slugifyIssueTitle(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return normalized || "imported";
}

async function loadImportPolicy(
  ports: GitHubIssueImportPorts,
  runtimeRoot: string,
): Promise<GitHubIssueImportPolicyInput> {
  // Nesamas ar sugadintas konfigas reiškia IŠJUNGTĄ importą (tuščias objektas → enabled false):
  // išorinis, tinklą liečiantis veiksmas niekada neįsijungia dėl neperskaitomo failo.
  const raw = await ports.readTextFileIfExists(path.join(runtimeRoot, "config", "github-policy.json"));
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as {
      owner?: unknown;
      repo?: unknown;
      issueImport?: GitHubIssueImportPolicyInput;
    };
    return {
      ...(typeof parsed.owner === "string" ? { owner: parsed.owner } : {}),
      ...(typeof parsed.repo === "string" ? { repo: parsed.repo } : {}),
      ...parsed.issueImport,
    };
  } catch {
    return {};
  }
}

export async function githubIssueImport(
  deps: GitHubIssueImportDeps,
  args: string[] = [],
): Promise<GitHubIssueImportCommandResult> {
  const issueNumber = parseIssueNumber(args);
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");

  const policy = await loadImportPolicy(deps.ports, runtimeRoot);
  const outcome = await deps.ports.importIssue({ policy, issueNumber });
  if (outcome.status !== "importable") {
    return { ...outcome, issue_number: issueNumber };
  }

  const fileName = `${String(outcome.issue.number).padStart(3, "0")}-github-issue-${slugifyIssueTitle(outcome.issue.title)}.md`;
  const taskPath = path.join(root, "AG", "tasks", "pending", fileName);
  await deps.ports.makeDirectory(path.dirname(taskPath));
  await deps.ports.writeTextFile(taskPath, deps.ports.renderIssueDraftTask(outcome.issue));

  return {
    status: "created",
    issue_number: outcome.issue.number,
    task_path: path.relative(root, taskPath).replace(/\\/g, "/"),
  };
}

export async function githubIssueImportCommand(deps: GitHubIssueImportDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await githubIssueImport(deps, args);
    io.out(`github-issue-import: ${result.status}`);
    io.out(`issue: ${result.issue_number}`);
    if (result.status === "created") {
      io.out(`task: ${result.task_path}`);
      return 0;
    }
    io.out(`message: ${result.message}`);
    // Išjungta politika yra sukonfigūruota būsena, ne gedimas; blogas konfigas ar issue — taip.
    return result.status === "disabled" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
