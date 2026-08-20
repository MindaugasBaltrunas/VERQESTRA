// GitHub PR automatika (etalonas: AG_loop integrations/github-pr.ts 1:1). Modulis pats
// HTTP nekviečia — realų API klientą injektuoja kvietėjas per `GitHubPrClient`; čia gyvena
// tik policy normalizacija ir vartai. Išjungta politika (`enabled !== true`) yra saugus
// numatytasis — PR kūrimas visada yra aiškiai įjungiamas išorinis veiksmas.

export type GitHubPrPolicy = {
  enabled: boolean;
  owner: string;
  repo: string;
  base: string;
  head: string;
  draft: boolean;
  labels: string[];
};

export type GitHubPrInput = {
  policy: GitHubPrPolicy;
  title: string;
  body: string;
};

export type GitHubPrCreated = {
  status: "created";
  number: number;
  url: string;
};

export type GitHubPrSkipped = {
  status: "disabled" | "invalid-config";
  message: string;
};

export type GitHubPrResult = GitHubPrCreated | GitHubPrSkipped;

export type GitHubPrClient = {
  createPullRequest(input: {
    owner: string;
    repo: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft: boolean;
    labels: string[];
  }): Promise<{ number: number; url: string }>;
};

export const defaultGitHubPrPolicy: GitHubPrPolicy = {
  enabled: false,
  owner: "",
  repo: "",
  base: "main",
  head: "",
  draft: true,
  labels: [],
};

export async function createGitHubPullRequest(input: GitHubPrInput, client: GitHubPrClient): Promise<GitHubPrResult> {
  const policy = normalizeGitHubPrPolicy(input.policy);
  if (!policy.enabled) {
    return { status: "disabled", message: "GitHub PR automation is disabled by policy." };
  }

  const missing = requiredPolicyFields(policy).filter((field) => policy[field].trim().length === 0);
  if (missing.length > 0) {
    return { status: "invalid-config", message: `GitHub PR policy missing required fields: ${missing.join(", ")}` };
  }

  const created = await client.createPullRequest({
    owner: policy.owner,
    repo: policy.repo,
    base: policy.base,
    head: policy.head,
    title: input.title,
    body: input.body,
    draft: policy.draft,
    labels: policy.labels,
  });

  return {
    status: "created",
    number: created.number,
    url: created.url,
  };
}

export function normalizeGitHubPrPolicy(raw: Partial<GitHubPrPolicy> | undefined): GitHubPrPolicy {
  return {
    enabled: raw?.enabled === true,
    owner: stringValue(raw?.owner),
    repo: stringValue(raw?.repo),
    base: stringValue(raw?.base) || defaultGitHubPrPolicy.base,
    head: stringValue(raw?.head),
    draft: raw?.draft !== false,
    labels: Array.isArray(raw?.labels)
      ? raw.labels.filter((label): label is string => typeof label === "string" && label.trim().length > 0)
      : [],
  };
}

function requiredPolicyFields(_policy: GitHubPrPolicy): Array<"owner" | "repo" | "base" | "head"> {
  return ["owner", "repo", "base", "head"];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
