import assert from "node:assert/strict";
import os from "node:os";
import test, { type TestContext } from "node:test";

import { UNAVAILABLE_TOOL_VERSION } from "../application/run-environment.js";
import { REDACTION_PLACEHOLDER } from "../application/secret-redaction.js";
import {
  HostEnvironmentAdapter,
  execFileCommandRunner,
  type CommandResult,
  type CommandRunner,
} from "../infrastructure/environment-capture.js";
import { SYNTHETIC_SECRETS } from "./secret-samples.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** Answers only the commands a test declared; anything else is an absent tool. */
function fakeRunner(responses: Readonly<Record<string, CommandResult>>): CommandRunner {
  return async (command, args) =>
    responses[`${command} ${args.join(" ")}`] ?? { ok: false, output: "" };
}

const HEALTHY_HOST = {
  "git rev-parse HEAD": { ok: true, output: `${COMMIT}\n` },
  "git --version": { ok: true, output: "git version 2.43.0.windows.1\n" },
  "pnpm --version": { ok: true, output: "9.15.9\n" },
} as const;

function adapter(responses: Readonly<Record<string, CommandResult>> = HEALTHY_HOST): HostEnvironmentAdapter {
  return new HostEnvironmentAdapter({ runner: fakeRunner(responses), packageManagerUserAgent: "" });
}

test("the host facts come from the running process, not from a command", async () => {
  const environment = await adapter().capture();
  assert.deepEqual(environment, {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpuCount: os.availableParallelism(),
  });
});

test("a run records the commit and the tool versions it was executed with", async () => {
  const record = await adapter().captureRunEnvironment();
  assert.equal(record.agCommit, COMMIT);
  assert.equal(record.osRelease, `${os.type()} ${os.release()}`);
  assert.deepEqual(record.toolVersions, [
    { tool: "git", version: "git version 2.43.0.windows.1" },
    { tool: "node", version: process.version },
    { tool: "pnpm", version: "9.15.9" },
  ]);
  assert.deepEqual(record.environment, await adapter().capture());
});

test("an unreachable tool is recorded as unavailable rather than guessed", async () => {
  const record = await adapter({}).captureRunEnvironment();
  assert.equal(record.agCommit, "");
  assert.deepEqual(
    record.toolVersions.map((tool) => tool.version),
    [UNAVAILABLE_TOOL_VERSION, process.version, UNAVAILABLE_TOOL_VERSION],
  );
});

test("git output that is not a full object id is discarded, not stored as a commit", async () => {
  for (const output of ["fatal: not a git repository\n", "0123456\n", "HEAD\n", ""]) {
    const record = await adapter({
      "git rev-parse HEAD": { ok: true, output },
    }).captureRunEnvironment();
    assert.equal(record.agCommit, "", JSON.stringify(output));
  }
});

test("pnpm falls back to the package manager that launched the run", async () => {
  // The Windows shim is a `.cmd` file, so the spawn fails and the user agent —
  // set by the very pnpm running this test — is the only honest source left.
  const record = await new HostEnvironmentAdapter({
    runner: fakeRunner({}),
    packageManagerUserAgent: "pnpm/9.15.9 npm/? node/v22.14.0 win32 x64",
  }).captureRunEnvironment();
  assert.deepEqual(record.toolVersions[2], { tool: "pnpm", version: "9.15.9" });
});

test("a credential printed by a tool is not recorded", async () => {
  const leaked = SYNTHETIC_SECRETS.githubToken;
  const record = await adapter({
    "git --version": { ok: true, output: `git version 2.43.0 (GIT_ASKPASS_TOKEN=${leaked})\n` },
  }).captureRunEnvironment();
  const stored = JSON.stringify(record);
  assert.equal(stored.includes(leaked), false);
  assert.ok(stored.includes(REDACTION_PLACEHOLDER));
});

test("a tool that prints a wall of text contributes a bounded value", async () => {
  const record = await adapter({
    "git --version": { ok: true, output: `git version ${"x".repeat(5_000)}` },
  }).captureRunEnvironment();
  assert.ok((record.toolVersions[0]?.version.length ?? 0) <= 200);
});

test("environment variables are never part of the record", async (t: TestContext) => {
  const secret = SYNTHETIC_SECRETS.anthropicApiKey;
  process.env["AG_BENCHMARK_TEST_CREDENTIAL"] = secret;
  t.after(() => {
    delete process.env["AG_BENCHMARK_TEST_CREDENTIAL"];
  });

  const record = await adapter().captureRunEnvironment();
  const stored = JSON.stringify(record);
  assert.equal(stored.includes(secret), false);
  assert.equal(stored.includes("AG_BENCHMARK_TEST_CREDENTIAL"), false);
});

test("the default runner executes a program without a shell and reports failure as failure", async () => {
  const version = await execFileCommandRunner(process.execPath, ["--version"]);
  assert.equal(version.ok, true);
  assert.match(version.output.trim(), /^v\d+\.\d+\.\d+/);

  const refused = await execFileCommandRunner(process.execPath, ["--this-flag-does-not-exist"]);
  assert.deepEqual(refused, { ok: false, output: "" });
});
