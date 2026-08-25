// Commit convergence wiring testai (composition sluoksnis).
//
// Trys klausimai, į kuriuos šis rinkinys atsako:
//   1. ar adapteriai surišti su TIKRAIS portais (project status realiai parašomas, converge
//      realiai perleidžiamas, telemetry realiai atsiranda diske);
//   2. ar nesėkmė lieka nesėkme TIK telemetry prasme — `recordCommitConvergence` nemeta;
//   3. ar Stop hook'o `commitAndPush` po sėkmingo commit'o kviečia konvergenciją IR išlieka
//      sėkmingas net tada, kai ta konvergencija krenta.
//
// Trečias punktas dirba su REALIU git repo laikiname kataloge — kaip `infrastructure-git`
// rinkinys. Fake git čia nieko neįrodytų: tikrinamas būtent tas kelias, kuriuo hook'as rašo
// į istoriją.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type {
  CommitConvergencePorts,
  CommitConvergenceTelemetry,
} from "../application/release-readiness/commit-convergence.js";
import { runCommitConvergence } from "../application/release-readiness/commit-convergence.js";
import { taskBuckets, type TaskBucket } from "../domain/tasks/buckets.js";
import {
  commitConvergencePorts,
  recordCommitConvergence,
} from "../composition/quality/commit-convergence-adapters.js";
import { stopHookPorts } from "../composition/hooks/stop-adapters.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";

const roots: string[] = [];
after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function emptyTaskFiles(): Record<TaskBucket, string[]> {
  const files = {} as Record<TaskBucket, string[]>;
  for (const bucket of taskBuckets) files[bucket] = [];
  return files;
}

function telemetryFile(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "commit-convergence.jsonl");
}

async function readTelemetryLines(runtimeRoot: string): Promise<CommitConvergenceTelemetry[]> {
  const raw = await nodeFsAdapter.readTextFileIfExists(telemetryFile(runtimeRoot));
  return (raw ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CommitConvergenceTelemetry);
}

test("commitConvergencePorts: realūs portai — status parašomas, converge perleidžiamas, telemetry atsiranda", async () => {
  const projectRoot = await makeRoot("vq-cc-ports-");
  const runtimeRoot = path.join(projectRoot, "vq");

  // Minimali eilė: vienas task'as `queue` bucket'e. `queue` NĖRA nebaigtas darbas, tad
  // project status verdiktas neturi tapti "issues" vien dėl jo.
  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "AG", "tasks", "queue", "001-demo.md"), "# demo\n");

  const ports = commitConvergencePorts({ projectRoot, runtimeRoot });
  const result = await runCommitConvergence(ports, { commit: "abc1234" });

  // Project status portas realiai rašo abu dokumentus.
  assert.equal(await nodeFsAdapter.exists(path.join(runtimeRoot, "project", "status.md")), true);
  assert.equal(await nodeFsAdapter.exists(path.join(runtimeRoot, "project", "next-tasks.md")), true);
  assert.match(
    (await readFile(path.join(runtimeRoot, "project", "next-tasks.md"), "utf8")),
    /001-demo\.md/,
  );

  // Release proof šviežio nėra, tad status verdiktas — "issues" su įvardyta priežastimi.
  assert.equal(result.status.status, "issues");
  assert.ok(result.status.issues.some((issue) => issue.startsWith("release proof")), JSON.stringify(result.status));

  // Converge portas grąžina tikrą rezultatą, ne stubą.
  assert.ok(result.converge.status === "converged" || result.converge.status === "issues");

  // Telemetry įrašas — viena JSONL eilutė su laikrodžio žyma.
  const lines = await readTelemetryLines(runtimeRoot);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.commit, "abc1234");
  assert.equal(lines[0]?.projectStatus, "issues");
  assert.equal(lines[0]?.convergeStatus, result.converge.status);
  assert.ok(!Number.isNaN(Date.parse(lines[0]?.at ?? "")));

  // Antras perleidimas PRIDEDA eilutę, o ne perrašo istoriją.
  await runCommitConvergence(ports, { commit: "def5678" });
  assert.deepEqual((await readTelemetryLines(runtimeRoot)).map((entry) => entry.commit), ["abc1234", "def5678"]);
});

test("recordCommitConvergence: krentantis portas negrąžina rezultato, nemeta ir palieka pėdsaką hooks.log", async () => {
  const projectRoot = await makeRoot("vq-cc-fail-");
  const runtimeRoot = path.join(projectRoot, "vq");

  const failing: CommitConvergencePorts = {
    runProjectStatus: () => Promise.reject(new Error("project status nulūžo")),
    runConverge: () => assert.fail("converge neturi būti pasiektas"),
    writeTelemetry: () => assert.fail("telemetry neturi būti rašomas"),
    now: () => "1970-01-01T00:00:00.000Z",
  };

  const outcome = await recordCommitConvergence({ ports: failing, runtimeRoot, commit: "deadbee" });

  assert.equal(outcome, undefined);
  const log = (await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "hooks.log"))) ?? "";
  assert.match(log, /commit-convergence deadbee NEPAVYKO: project status nulūžo/);
});

test("recordCommitConvergence: be commit SHA įrašas vis tiek rašomas su `unknown`", async () => {
  const projectRoot = await makeRoot("vq-cc-unknown-");
  const runtimeRoot = path.join(projectRoot, "vq");
  const written: CommitConvergenceTelemetry[] = [];

  const ports: CommitConvergencePorts = {
    runProjectStatus: () => Promise.resolve({ status: "ok", issues: [] }),
    runConverge: () =>
      Promise.resolve({
        status: "converged",
        active_spec: undefined,
        planned_tasks: [],
        task_files: emptyTaskFiles(),
        issues: [],
      }),
    writeTelemetry: (record) => {
      written.push(record);
      return Promise.resolve();
    },
    now: () => "1970-01-01T00:00:00.000Z",
  };

  const outcome = await recordCommitConvergence({ ports, runtimeRoot, commit: undefined });

  assert.equal(outcome?.telemetry.commit, "unknown");
  assert.deepEqual(written.map((entry) => entry.commit), ["unknown"]);
});

test("stop-adapters: po sėkmingo commit'o konvergencija perleidžiama ir telemetry įrašas turi tikrą SHA", async () => {
  const projectRoot = await makeRoot("vq-cc-stop-");
  const runtimeRoot = path.join(projectRoot, "vq");
  const git = async (...args: string[]): Promise<void> => {
    const result = await run("git", ["-C", projectRoot, ...args]);
    assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  };

  await git("init");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "src", "a.ts"), "pradinis\n");

  const ports = stopHookPorts(projectRoot, runtimeRoot);
  const result = await ports.commitAndPush({
    projectRoot,
    message: "pradinis commit",
    paths: ["src/a.ts"],
    push: false,
  });

  assert.equal(result.ok, true, JSON.stringify(result));

  const head = (await run("git", ["-C", projectRoot, "rev-parse", "HEAD"])).stdout.trim();
  const lines = await readTelemetryLines(runtimeRoot);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.commit, head);
});

test("stop-adapters: krentanti konvergencija NEPAVERČIA commit'o nesėkme", async () => {
  const projectRoot = await makeRoot("vq-cc-stop-fail-");
  const runtimeRoot = path.join(projectRoot, "vq");
  const git = async (...args: string[]): Promise<void> => {
    const result = await run("git", ["-C", projectRoot, ...args]);
    assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  };

  await git("init");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "src", "a.ts"), "pradinis\n");

  // `<runtimeRoot>/state` yra FAILAS, ne katalogas: telemetry rašymas neišvengiamai lūžta
  // (ENOTDIR). Tai realistiškiausia gedimo injekcija — jokio kodo kelio nekeičia.
  await nodeFsAdapter.makeDirectory(runtimeRoot);
  await writeFile(path.join(runtimeRoot, "state"), "ne katalogas\n", "utf8");

  const ports = stopHookPorts(projectRoot, runtimeRoot);
  const result = await ports.commitAndPush({
    projectRoot,
    message: "pradinis commit",
    paths: ["src/a.ts"],
    push: false,
  });

  // Commit'as įvyko ir hook'as jį mato sėkmingu.
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await run("git", ["-C", projectRoot, "rev-parse", "HEAD"])).code, 0);

  // Bet tyliai nepraėjo: nesėkmė yra hooks.log.
  const log = (await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "hooks.log"))) ?? "";
  assert.match(log, /commit-convergence .* NEPAVYKO/);
  assert.match(log, /commit'as lieka sėkmingas/);
});
