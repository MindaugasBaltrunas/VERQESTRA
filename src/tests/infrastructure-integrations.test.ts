// VQ-404 (2/2) testai — GitHub integracijos (client-injected, be HTTP): issue importo
// vartai + draft render'is ir PR automatikos policy normalizacija.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultGitHubIssueImportPolicy,
  getImportableGitHubIssue,
  normalizeGitHubIssueImportPolicy,
  renderIssueDraftTask,
  type GitHubIssue,
  type GitHubIssueClient,
} from "../infrastructure/integrations/github-issues.js";
import {
  createGitHubPullRequest,
  defaultGitHubPrPolicy,
  normalizeGitHubPrPolicy,
  type GitHubPrClient,
} from "../infrastructure/integrations/github-pr.js";

const ISSUE: GitHubIssue = {
  number: 7,
  title: "Fix login",
  body: "  Body text  ",
  url: "https://github.com/o/r/issues/7",
  labels: ["bug"],
};

function issueClient(calls: unknown[]): GitHubIssueClient {
  return {
    async getIssue(input) {
      calls.push(input);
      return ISSUE;
    },
  };
}

test("github-issues: išjungta politika, invalid numeris ir trūkstami laukai blokuoja PRIEŠ client kvietimą", async () => {
  const calls: unknown[] = [];
  const client = issueClient(calls);

  const disabled = await getImportableGitHubIssue({ policy: defaultGitHubIssueImportPolicy, issueNumber: 7 }, client);
  assert.equal(disabled.status, "disabled");

  const invalid = await getImportableGitHubIssue(
    { policy: { enabled: true, owner: "o", repo: "r" }, issueNumber: 0 },
    client,
  );
  assert.equal(invalid.status, "invalid-issue");

  const missing = await getImportableGitHubIssue(
    { policy: { enabled: true, owner: "  ", repo: "r" }, issueNumber: 7 },
    client,
  );
  assert.equal(missing.status, "invalid-config");
  assert.match(missing.status === "invalid-config" ? missing.message : "", /owner/);
  assert.equal(calls.length, 0, "client nekviečiamas, kol vartai nepraeiti");

  const importable = await getImportableGitHubIssue(
    { policy: { enabled: true, owner: "o", repo: "r" }, issueNumber: 7 },
    client,
  );
  assert.equal(importable.status, "importable");
  assert.deepEqual(calls, [{ owner: "o", repo: "r", issueNumber: 7 }]);
});

test("github-issues: normalizacija ir draft task render'is su TODO scope (ne auto-run)", () => {
  assert.deepEqual(normalizeGitHubIssueImportPolicy(undefined), { enabled: false, owner: "", repo: "" });
  assert.deepEqual(normalizeGitHubIssueImportPolicy({ enabled: true, owner: " o ", repo: " r " }), {
    enabled: true,
    owner: "o",
    repo: "r",
  });

  const draft = renderIssueDraftTask(ISSUE);
  assert.ok(draft.startsWith("# Task: Fix login\n"));
  assert.ok(draft.includes("GitHub issue 7"));
  assert.ok(draft.includes("https://github.com/o/r/issues/7"));
  assert.ok(draft.includes("Body text"));
  assert.ok(draft.includes("- TODO: define the smallest safe scope"));
  assert.ok(draft.includes("Do not auto-run this task until scope and checks are reviewed."));

  const empty = renderIssueDraftTask({ ...ISSUE, body: "   " });
  assert.ok(empty.includes("No issue body provided."));
});

test("github-pr: disabled/invalid-config vartai, normalizacija su base default'u ir labels filtru, created kelias", async () => {
  const calls: unknown[] = [];
  const client: GitHubPrClient = {
    async createPullRequest(input) {
      calls.push(input);
      return { number: 42, url: "https://github.com/o/r/pull/42" };
    },
  };

  const disabled = await createGitHubPullRequest({ policy: defaultGitHubPrPolicy, title: "t", body: "b" }, client);
  assert.equal(disabled.status, "disabled");

  const invalid = await createGitHubPullRequest(
    { policy: { ...defaultGitHubPrPolicy, enabled: true, owner: "o", repo: "r" }, title: "t", body: "b" },
    client,
  );
  assert.equal(invalid.status, "invalid-config");
  assert.match(invalid.status === "invalid-config" ? invalid.message : "", /head/);
  assert.equal(calls.length, 0);

  const normalized = normalizeGitHubPrPolicy({ enabled: true, owner: "o", repo: "r", head: "feat", labels: ["ok", " ", 7 as unknown as string] });
  assert.equal(normalized.base, "main", "trūkstamas base krenta į default'ą");
  assert.equal(normalized.draft, true, "draft default'as — true");
  assert.deepEqual(normalized.labels, ["ok"]);

  const created = await createGitHubPullRequest({ policy: normalized, title: "T", body: "B" }, client);
  assert.deepEqual(created, { status: "created", number: 42, url: "https://github.com/o/r/pull/42" });
  assert.deepEqual(calls, [
    { owner: "o", repo: "r", base: "main", head: "feat", title: "T", body: "B", draft: true, labels: ["ok"] },
  ]);
});
