// GitHub issue -> draft task importas (etalonas: AG_loop integrations/github-issues.ts 1:1).
// Modulis pats HTTP nekviečia — realų API klientą injektuoja kvietėjas per
// `GitHubIssueClient`; čia gyvena tik policy normalizacija, vartai ir draft render'is.
// Importuotas draft'as SĄMONINGAI turi TODO scope/checks — jis niekada neina tiesiai į
// queue be žmogaus peržiūros.

export type GitHubIssueImportPolicy = {
  enabled: boolean;
  owner: string;
  repo: string;
};

export type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
};

export type GitHubIssueClient = {
  getIssue(input: { owner: string; repo: string; issueNumber: number }): Promise<GitHubIssue>;
};

export type GitHubIssueImportResult =
  | { status: "disabled" | "invalid-config" | "invalid-issue"; message: string }
  | { status: "importable"; issue: GitHubIssue };

export const defaultGitHubIssueImportPolicy: GitHubIssueImportPolicy = {
  enabled: false,
  owner: "",
  repo: "",
};

export async function getImportableGitHubIssue(
  input: { policy: GitHubIssueImportPolicy; issueNumber: number },
  client: GitHubIssueClient,
): Promise<GitHubIssueImportResult> {
  const policy = normalizeGitHubIssueImportPolicy(input.policy);
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    return { status: "invalid-issue", message: "GitHub issue import requires a positive integer issue number." };
  }
  if (!policy.enabled) {
    return { status: "disabled", message: "GitHub issue import is disabled by policy." };
  }

  const missing = requiredPolicyFields(policy).filter((field) => policy[field].trim().length === 0);
  if (missing.length > 0) {
    return { status: "invalid-config", message: `GitHub issue import policy missing required fields: ${missing.join(", ")}` };
  }

  return {
    status: "importable",
    issue: await client.getIssue({ owner: policy.owner, repo: policy.repo, issueNumber: input.issueNumber }),
  };
}

export function normalizeGitHubIssueImportPolicy(raw: Partial<GitHubIssueImportPolicy> | undefined): GitHubIssueImportPolicy {
  return {
    enabled: raw?.enabled === true,
    owner: stringValue(raw?.owner),
    repo: stringValue(raw?.repo),
  };
}

export function renderIssueDraftTask(issue: GitHubIssue): string {
  return `# Task: ${issue.title}

## Spec source
GitHub issue ${issue.number}

## Source link
${issue.url}

## Goal
${issue.title}

## Issue summary
${issue.body.trim() || "No issue body provided."}

## Allowed files
- TODO: define the smallest safe scope before moving this task to queue.

## Forbidden files
- files outside the allowed list

## Actions
- TODO: convert this issue into one bounded implementation step.

## Acceptance criteria
- TODO: define observable completion criteria.

## Checks
- TODO: add required local checks, for example \`pnpm build\` and \`pnpm test\`.

## Out of scope
- Do not close or edit the source GitHub issue from this imported task.
- Do not auto-run this task until scope and checks are reviewed.
`;
}

function requiredPolicyFields(_policy: GitHubIssueImportPolicy): Array<"owner" | "repo"> {
  return ["owner", "repo"];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
