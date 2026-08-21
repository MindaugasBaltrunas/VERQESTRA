// VQ-501 (5/5-c) testai — GitHub komandų handleriai per fake portus: issue importas
// (vartai, draft'o kelias AG/tasks/pending, exit kontraktas disabled → 0 vs invalid → 1) ir
// PR komanda (trys vartai prieš tinklą, dry-run vis tiek rašo rezultatą, teksto sekcijos).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { CliIo } from "../interfaces/cli/registry.js";
import {
  githubIssueImport,
  githubIssueImportCommand,
  parseIssueNumber,
  slugifyIssueTitle,
  type GitHubIssueImportOutcome,
  type GitHubIssueImportPolicyInput,
  type GitHubIssueImportPorts,
  type GitHubIssueView,
} from "../interfaces/cli/github/issue-import.js";
import {
  buildPullRequestBody,
  githubPr,
  githubPrCommand,
  type GitHubPrOutcome,
  type GitHubPrPolicyInput,
  type GitHubPrPorts,
} from "../interfaces/cli/github/pull-request.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

// ---------------------------------------------------------------------------
// github-issue-import
// ---------------------------------------------------------------------------

const ISSUE: GitHubIssueView = {
  number: 7,
  title: "Add rate limiting to the API",
  body: "We need a limiter.",
  url: "https://github.com/acme/app/issues/7",
  labels: ["enhancement"],
};

function issuePorts(input: {
  config?: string;
  outcome?: GitHubIssueImportOutcome;
} = {}): { ports: GitHubIssueImportPorts; written: Map<string, string>; seenPolicy: GitHubIssueImportPolicyInput[] } {
  const written = new Map<string, string>();
  const seenPolicy: GitHubIssueImportPolicyInput[] = [];
  return {
    written,
    seenPolicy,
    ports: {
      readTextFileIfExists: async (p) => (rel(p) === "vq/config/github-policy.json" ? input.config : undefined),
      writeTextFile: async (p, content) => void written.set(rel(p), content),
      makeDirectory: async () => {},
      importIssue: async ({ policy }) => {
        seenPolicy.push(policy);
        return input.outcome ?? { status: "importable", issue: ISSUE };
      },
      renderIssueDraftTask: (issue) => `# Task: ${issue.title}\n`,
    },
  };
}

test("parseIssueNumber ir slugifyIssueTitle: argumentų kontraktas ir failo vardo dalis", () => {
  assert.equal(parseIssueNumber(["--issue", "42"]), 42);
  assert.throws(() => parseIssueNumber([]), /requires --issue <number>/);
  assert.throws(() => parseIssueNumber(["--issue", "42", "--force"]), /Unknown github-issue-import option: --force/);

  assert.equal(slugifyIssueTitle("Add rate limiting to the API"), "add-rate-limiting-to-the-api");
  assert.equal(slugifyIssueTitle("!!!"), "imported");
  assert.equal(slugifyIssueTitle("a".repeat(80)).length, 60);
});

test("githubIssueImport: draft'as rašomas į AG/tasks/pending, ne į ciklo bucket'ą", async () => {
  const world = issuePorts({
    config: JSON.stringify({ owner: "acme", repo: "app", issueImport: { enabled: true } }),
  });
  const result = await githubIssueImport({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, [
    "--issue",
    "7",
  ]);

  assert.equal(result.status, "created");
  assert.equal(result.status === "created" && result.task_path, "AG/tasks/pending/007-github-issue-add-rate-limiting-to-the-api.md");
  assert.ok(world.written.has("AG/tasks/pending/007-github-issue-add-rate-limiting-to-the-api.md"));
  // Politika perduodama adapteriui neapdorota — normalizacija ir vartai gyvena ten.
  assert.deepEqual(world.seenPolicy[0], { owner: "acme", repo: "app", enabled: true });
});

test("githubIssueImport: nesamas ir sugadintas konfigas duoda tuščią politiką (importas išjungtas)", async () => {
  const missing = issuePorts({ outcome: { status: "disabled", message: "GitHub issue import is disabled by policy." } });
  await githubIssueImport({ ports: missing.ports, projectRoot: ROOT }, ["--issue", "7"]);
  assert.deepEqual(missing.seenPolicy[0], {});

  const broken = issuePorts({
    config: "{ not json",
    outcome: { status: "disabled", message: "GitHub issue import is disabled by policy." },
  });
  await githubIssueImport({ ports: broken.ports, projectRoot: ROOT }, ["--issue", "7"]);
  assert.deepEqual(broken.seenPolicy[0], {});
});

test("githubIssueImportCommand: disabled → 0, invalid-config → 1, blogas argumentas → 2", async () => {
  const disabled = issuePorts({ outcome: { status: "disabled", message: "GitHub issue import is disabled by policy." } });
  const off = captureIo();
  assert.equal(
    await githubIssueImportCommand({ ports: disabled.ports, projectRoot: ROOT, io: off.io }, ["--issue", "7"]),
    0,
  );
  assert.deepEqual(off.out, [
    "github-issue-import: disabled",
    "issue: 7",
    "message: GitHub issue import is disabled by policy.",
  ]);
  assert.equal(disabled.written.size, 0);

  const invalid = issuePorts({ outcome: { status: "invalid-config", message: "missing owner" } });
  const bad = captureIo();
  assert.equal(
    await githubIssueImportCommand({ ports: invalid.ports, projectRoot: ROOT, io: bad.io }, ["--issue", "7"]),
    1,
  );
  assert.ok(bad.out.includes("message: missing owner"));

  const usage = captureIo();
  assert.equal(await githubIssueImportCommand({ ports: invalid.ports, projectRoot: ROOT, io: usage.io }, []), 2);
  assert.match(usage.err[0] ?? "", /requires --issue <number>/);
});

test("githubIssueImportCommand: sėkmė spausdina task kelią ir grąžina 0", async () => {
  const world = issuePorts({ config: JSON.stringify({ owner: "acme", repo: "app", issueImport: { enabled: true } }) });
  const { io, out } = captureIo();
  assert.equal(
    await githubIssueImportCommand({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, [
      "--issue",
      "7",
    ]),
    0,
  );
  assert.equal(out[0], "github-issue-import: created");
  assert.equal(out[1], "issue: 7");
  assert.match(out[2] ?? "", /^task: AG\/tasks\/pending\/007-github-issue-/);
});

// ---------------------------------------------------------------------------
// github-pr
// ---------------------------------------------------------------------------

function prPorts(
  files: Record<string, string> = {},
  outcome: GitHubPrOutcome = { status: "created", number: 12, url: "https://github.com/acme/app/pull/12" },
): { ports: GitHubPrPorts; written: Map<string, string>; created: Array<{ policy: GitHubPrPolicyInput; title: string }> } {
  const written = new Map<string, string>();
  const created: Array<{ policy: GitHubPrPolicyInput; title: string }> = [];
  const read = async (p: string): Promise<string | undefined> => files[rel(p)];
  return {
    written,
    created,
    ports: {
      policyFs: { readTextFileIfExists: read },
      readTextFileIfExists: read,
      writeTextFile: async (p, content) => void written.set(rel(p), content),
      makeDirectory: async () => {},
      createPullRequest: async ({ policy, title }) => {
        created.push({ policy, title });
        return outcome;
      },
    },
  };
}

const PR_STATE: Record<string, string> = {
  "vq/state/current-task-id": "0042\n",
  "vq/state/current-task-file": "AG/tasks/active/0042.md\n",
  "vq/project/status.md": "Projektas žalias.\n",
  "vq/state/quality-gates-status.json": JSON.stringify({ commands: ["pnpm test", "pnpm typecheck"] }),
  "vq/state/spec-drift-result.json": JSON.stringify({ status: "ok" }),
};

test("githubPr: be --create tinklo nėra, bet rezultatas įrašomas (dry run)", async () => {
  const world = prPorts(PR_STATE);
  const result = await githubPr({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, []);

  assert.equal(result.status, "disabled");
  assert.equal(world.created.length, 0, "dry run niekada neliečia tinklo");
  assert.equal(result.title, "AG task 0042");
  assert.equal(result.result_path, "vq/state/github-pr-result.json");
  const written = JSON.parse(world.written.get("vq/state/github-pr-result.json") ?? "{}") as { title: string };
  assert.equal(written.title, "AG task 0042");
});

test("githubPr: --create praleidžia vartus ir perduoda politiką bei tekstą adapteriui", async () => {
  const world = prPorts({
    ...PR_STATE,
    "vq/config/github-policy.json": JSON.stringify({ enabled: true, owner: "acme", repo: "app", head: "feature" }),
  });
  const result = await githubPr({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, ["--create"]);

  assert.equal(result.status, "created");
  assert.equal(result.status === "created" && result.url, "https://github.com/acme/app/pull/12");
  assert.equal(world.created.length, 1);
  assert.equal(world.created[0]?.policy.owner, "acme");
  assert.equal(world.created[0]?.title, "AG task 0042");
});

test("githubPr: išjungta git automatikos politika sustabdo net su --create", async () => {
  const world = prPorts({
    ...PR_STATE,
    "vq/config/git-automation-policy.json": JSON.stringify({ pr_after_successful_task: false }),
    "vq/config/github-policy.json": JSON.stringify({ enabled: true, owner: "acme", repo: "app", head: "feature" }),
  });
  const result = await githubPr({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, ["--create"]);

  assert.equal(result.status, "disabled");
  assert.equal(result.status === "disabled" && result.message, "GitHub PR automation is disabled by AG git automation policy.");
  assert.equal(world.created.length, 0);
});

test("buildPullRequestBody: sekcijos, patikros ir trūkstami rezultatų failai", async () => {
  const world = prPorts(PR_STATE);
  const result = await githubPr({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, []);

  assert.match(result.body, /^## Summary\n\nProjektas žalias\./);
  assert.match(result.body, /- Task id: 0042/);
  assert.match(result.body, /- Task file: AG\/tasks\/active\/0042\.md/);
  assert.match(result.body, /- pnpm test\n- pnpm typecheck/);
  assert.match(result.body, /- spec-drift-result\.json: ok/);
  assert.match(result.body, /- security-verify-result\.json: missing/);

  const empty = buildPullRequestBody({
    taskId: "unknown-task",
    taskFile: "unknown",
    projectStatus: "No project status file found.",
    checks: [],
    results: {},
  });
  assert.match(empty, /- No checks recorded\./);
});

test("githubPrCommand: created spausdina url, dry run — message; blogas argumentas → 2", async () => {
  const createdWorld = prPorts({
    ...PR_STATE,
    "vq/config/github-policy.json": JSON.stringify({ enabled: true, owner: "acme", repo: "app", head: "feature" }),
  });
  const ok = captureIo();
  assert.equal(
    await githubPrCommand({ ports: createdWorld.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: ok.io }, [
      "--create",
    ]),
    0,
  );
  assert.deepEqual(ok.out, [
    "github-pr: created",
    "title: AG task 0042",
    "url: https://github.com/acme/app/pull/12",
  ]);

  const dry = captureIo();
  const dryWorld = prPorts(PR_STATE);
  assert.equal(
    await githubPrCommand({ ports: dryWorld.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: dry.io }, []),
    0,
  );
  assert.match(dry.out[2] ?? "", /^message: Dry run only\./);

  const bad = captureIo();
  assert.equal(
    await githubPrCommand({ ports: dryWorld.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: bad.io }, [
      "--force",
    ]),
    2,
  );
  assert.equal(bad.err[0], "Unknown github-pr option: --force");
});
