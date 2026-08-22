import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { IsolatedWorktree } from "../application/ports/worktree-port.js";
import { BENCHMARK_PACKAGE_ROOT } from "../infrastructure/benchmark-workspace-paths.js";
import { FixtureRepositoryStore } from "../infrastructure/fixtures/fixture-repository.js";
import {
  ALLOWED_GIT_SUBCOMMANDS,
  execFileGitRunner,
  runGit,
  type GitRunner,
} from "../infrastructure/git/git-runner.js";
import {
  BENCHMARK_BRANCH_NAMESPACE,
  GitWorktreeManager,
  MAX_DIFF_CHARACTERS,
  UnsafeIdentifierError,
} from "../infrastructure/git/git-worktree-manager.js";
import { createTemporaryRunRoot, type VerifiedRoot } from "../infrastructure/git/verified-root.js";
import { SYNTHETIC_SECRETS } from "./secret-samples.js";

/**
 * Isolation, end to end, against real Git (BENCH-4).
 *
 * These tests execute Git rather than a double, because every claim being made
 * is a claim about Git's behaviour: that a worktree is a separate checkout, that
 * a base branch does not move when another branch is committed to, that
 * `worktree remove` refuses a dirty checkout unless forced. A stub asked about
 * any of those would answer whatever this package assumed, which is exactly the
 * assumption under test. Git not being installed therefore fails these tests, as
 * it should: a worktree runner on a host without Git is not partially working.
 *
 * The fixture is this package's own `fixtures/docs-site`, so the isolation is
 * proven against a fixture the suite really runs, not one written to pass.
 */

const FIXTURE = "fixtures/docs-site";
const FIXTURE_FILE = "README.md";

interface Harness {
  readonly manager: GitWorktreeManager;
  readonly fixtures: FixtureRepositoryStore;
  readonly root: VerifiedRoot;
  /** Every argument vector handed to Git, in order, for the argv audit below. */
  readonly issued: readonly (readonly string[])[];
}

async function harness(t: TestContext, runId = "run-0001"): Promise<Harness> {
  const issued: string[][] = [];
  const runner: GitRunner = async (args, options) => {
    issued.push([...args]);
    return execFileGitRunner(args, options);
  };
  const root = await createTemporaryRunRoot(`ag-benchmark-${runId}-`);
  t.after(async () => {
    await rm(root.path, { recursive: true, force: true });
  });
  const fixtures = new FixtureRepositoryStore(root, { runner });
  return {
    root,
    fixtures,
    issued,
    manager: new GitWorktreeManager(runId, root, { runner, fixtures, ownsRunRoot: true }),
  };
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function headOf(worktreePath: string): Promise<string> {
  const output = await runGit(
    execFileGitRunner,
    ["rev-parse", "HEAD"],
    { cwd: worktreePath },
    "reading HEAD",
  );
  return output.trim();
}

/** The change a scenario execution would leave behind: one edit and one new file. */
async function performWork(worktree: IsolatedWorktree): Promise<void> {
  await appendFile(path.join(worktree.path, FIXTURE_FILE), "\nAdded by a benchmark sample.\n", "utf8");
  await mkdir(path.join(worktree.path, "docs"), { recursive: true });
  await writeFile(path.join(worktree.path, "docs", "new-page.md"), "# new page\n", "utf8");
}

test("every sample gets its own checkout and branch off one shared base commit", async (t) => {
  const { manager, fixtures, root } = await harness(t);
  const repository = await fixtures.materialize(FIXTURE);

  const first = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  const second = await manager.create({ scenarioId: "docs-fix-typo", fixturePath: FIXTURE });

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.path, second.path);
  assert.equal(first.startCommit, repository.baseCommit);
  assert.equal(second.startCommit, repository.baseCommit);
  for (const worktree of [first, second]) {
    assert.ok(root.contains(worktree.path), `${worktree.path} is outside the verified run root`);
    assert.ok(await exists(path.join(worktree.path, FIXTURE_FILE)), "the fixture was not checked out");
    assert.equal(await headOf(worktree.path), repository.baseCommit);
  }
  assert.deepEqual(
    manager.openWorktrees.map((worktree) => worktree.id),
    [first.id, second.id],
  );
});

test("the run root lies outside the repository the benchmark is measuring", async (t) => {
  const { manager } = await harness(t);
  const repositoryRoot = path.resolve(BENCHMARK_PACKAGE_ROOT, "..", "..");
  const relative = path.relative(repositoryRoot, manager.runRoot);
  assert.ok(
    relative.startsWith("..") || path.isAbsolute(relative),
    `scratch checkouts were placed at "${manager.runRoot}", inside the repository under measurement`,
  );
});

test("what an execution leaves behind is captured as a final commit, changed files and a diff", async (t) => {
  const { manager } = await harness(t);
  const worktree = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  await performWork(worktree);

  const capture = await manager.capture(worktree);

  assert.equal(capture.baseCommit, worktree.startCommit);
  assert.notEqual(capture.finalCommit, capture.baseCommit, "the executed change was not committed");
  assert.deepEqual(capture.changedFiles, [FIXTURE_FILE, "docs/new-page.md"]);
  assert.match(capture.diff.text, /docs\/new-page\.md/);
  assert.match(capture.diff.text, /\+# new page/);
  assert.equal(capture.diff.truncated, false);
  assert.ok(capture.diff.byteLength > 0);
});

test("an execution that changed nothing reports the base commit and an empty diff", async (t) => {
  const { manager } = await harness(t);
  const worktree = await manager.create({ scenarioId: "docs-no-op", fixturePath: FIXTURE });

  const capture = await manager.capture(worktree);

  assert.equal(capture.finalCommit, capture.baseCommit);
  assert.deepEqual(capture.changedFiles, []);
  assert.deepEqual(capture.diff, { text: "", truncated: false, byteLength: 0 });
});

test("committing one sample moves neither the base branch nor another sample", async (t) => {
  const { manager, fixtures } = await harness(t);
  const repository = await fixtures.materialize(FIXTURE);
  const first = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  const second = await manager.create({ scenarioId: "docs-fix-typo", fixturePath: FIXTURE });

  await performWork(first);
  const capture = await manager.capture(first);
  assert.notEqual(capture.finalCommit, repository.baseCommit);

  const baseBranch = await runGit(
    execFileGitRunner,
    ["rev-parse", repository.baseBranch],
    { cwd: repository.path },
    "reading the base branch",
  );
  assert.equal(baseBranch.trim(), repository.baseCommit, "the fixture base branch moved");
  assert.equal(await headOf(second.path), repository.baseCommit, "another sample's checkout moved");
  assert.ok(
    !(await exists(path.join(second.path, "docs", "new-page.md"))),
    "one sample's work appeared in another sample's checkout",
  );
});

test("cleanup removes the checkout it created and leaves every other one alone", async (t) => {
  const { manager, fixtures } = await harness(t);
  const repository = await fixtures.materialize(FIXTURE);
  const first = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  const second = await manager.create({ scenarioId: "docs-fix-typo", fixturePath: FIXTURE });
  await performWork(first);
  await manager.capture(first);

  const outcome = await manager.cleanupIsolated(first);

  assert.deepEqual(outcome, { result: "removed", reason: "" });
  assert.ok(!(await exists(first.path)), "the checkout was not removed");
  assert.ok(await exists(second.path), "cleanup removed a checkout it was not asked about");
  assert.ok(await exists(repository.path), "cleanup removed the fixture repository");
  assert.deepEqual(
    manager.openWorktrees.map((worktree) => worktree.id),
    [second.id],
  );
});

test("a checkout another run owns is refused, not cleaned up", async (t) => {
  const mine = await harness(t, "run-0001");
  const theirs = await harness(t, "run-0002");
  const foreign = await theirs.manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });

  const outcome = await mine.manager.cleanupIsolated(foreign);

  assert.equal(outcome.result, "failed");
  assert.match(outcome.reason, /^unknown-worktree:/);
  assert.ok(await exists(foreign.path), "another run's checkout was removed");
});

test("a known id pointing at an unexpected path is refused", async (t) => {
  const { manager } = await harness(t);
  const worktree = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  const elsewhere = await mkdtemp(path.join(tmpdir(), "ag-benchmark-bystander-"));
  t.after(async () => {
    await rm(elsewhere, { recursive: true, force: true });
  });

  const outcome = await manager.cleanupIsolated({ ...worktree, path: elsewhere });

  assert.equal(outcome.result, "failed");
  assert.match(outcome.reason, /^path-mismatch:/);
  assert.ok(await exists(elsewhere), "a directory outside the run root was removed");
  assert.ok(await exists(worktree.path), "the real checkout was removed by a mismatched request");
});

test("a checkout with uncommitted work is kept for diagnosis rather than forced away", async (t) => {
  const { manager } = await harness(t);
  const worktree = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  await performWork(worktree);
  await manager.capture(worktree);
  // Something written after the capture — the shape a partially observed run
  // leaves behind, and the one case where removing the checkout loses evidence.
  await writeFile(path.join(worktree.path, "unobserved.md"), "# unobserved\n", "utf8");

  const outcome = await manager.cleanupIsolated(worktree);

  assert.equal(outcome.result, "kept-for-diagnosis");
  assert.match(outcome.reason, /^dirty-worktree:/);
  assert.ok(await exists(worktree.path), "a dirty checkout was removed anyway");
});

test("a crashed run keeps its evidence, can be reclaimed, and blocks disposal until resolved", async (t) => {
  const { manager } = await harness(t);
  const worktree = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  await performWork(worktree);
  // The run stops here: no capture, no cleanup, exactly as an interrupted
  // dispatch would leave it.

  const abandoned = await manager.reclaimAbandoned();
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0]?.id, worktree.id);
  assert.equal(abandoned[0]?.exists, true);
  assert.equal(abandoned[0]?.registered, true);
  assert.ok(abandoned[0]?.branch.startsWith(`${BENCHMARK_BRANCH_NAMESPACE}/run-0001/`));
  assert.ok(
    await exists(path.join(worktree.path, "docs", "new-page.md")),
    "the crashed run's work was discarded",
  );

  const blocked = await manager.dispose();
  assert.equal(blocked.removed, false);
  assert.match(blocked.reason, /^evidence-kept:/);
  assert.ok(await exists(manager.runRoot));

  // Recovery: the evidence is captured and only then released.
  const capture = await manager.capture(worktree);
  assert.deepEqual(capture.changedFiles, [FIXTURE_FILE, "docs/new-page.md"]);
  assert.deepEqual(await manager.cleanupIsolated(worktree), { result: "removed", reason: "" });
  assert.deepEqual(await manager.reclaimAbandoned(), []);

  const disposal = await manager.dispose();
  assert.deepEqual(disposal, { removed: true, reason: "" });
  assert.ok(!(await exists(manager.runRoot)), "the run root survived disposal");
});

test("a checkout whose directory has already gone is released rather than blocking disposal", async (t) => {
  const { manager } = await harness(t);
  const worktree = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  // Something outside this package removed the directory — a temp sweeper, a
  // stopped container, a person. Git still lists it until it is pruned.
  await rm(worktree.path, { recursive: true, force: true });

  const outcome = await manager.cleanupIsolated(worktree);

  assert.deepEqual(outcome, { result: "removed", reason: "" });
  assert.deepEqual(manager.openWorktrees, [], "the vanished checkout stayed on the books");
  assert.deepEqual(await manager.dispose(), { removed: true, reason: "" });
});

test("a credential in a changed file is redacted out of the recorded diff", async (t) => {
  const { manager } = await harness(t);
  const worktree = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  const secret = SYNTHETIC_SECRETS.githubToken;
  await writeFile(path.join(worktree.path, "leak.md"), `token: ${secret}\n`, "utf8");

  const capture = await manager.capture(worktree);

  assert.deepEqual(capture.changedFiles, ["leak.md"]);
  assert.ok(!capture.diff.text.includes(secret), "a credential survived into the recorded diff");
  assert.match(capture.diff.text, /\[redacted\]/);
});

test("a diff larger than the bound is truncated, and says so", async (t) => {
  const { manager } = await harness(t);
  const worktree = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  const lines = Math.ceil(MAX_DIFF_CHARACTERS / 20) + 100;
  await writeFile(
    path.join(worktree.path, "large.md"),
    Array.from({ length: lines }, (_, index) => `line ${index} padding padding`).join("\n"),
    "utf8",
  );

  const capture = await manager.capture(worktree);

  assert.deepEqual(capture.changedFiles, ["large.md"], "the file list stays complete");
  assert.equal(capture.diff.truncated, true);
  assert.ok(capture.diff.text.length <= MAX_DIFF_CHARACTERS);
  assert.ok(
    capture.diff.byteLength > MAX_DIFF_CHARACTERS,
    "the recorded size must be the one Git produced, not the truncated one",
  );
});

test("a hostile Git environment does not change what is measured", async (t) => {
  // `GIT_CONFIG_PARAMETERS` is equivalent to an arbitrary `-c`, and the dates
  // decide the commit id. Inheriting either would make the base commit depend on
  // the shell the benchmark happened to be started from.
  const hostile: Readonly<Record<string, string>> = {
    GIT_CONFIG_PARAMETERS: "'core.autocrlf=true' 'user.name=someone else'",
    GIT_AUTHOR_DATE: "2001-02-03T04:05:06+00:00",
    GIT_COMMITTER_DATE: "2001-02-03T04:05:06+00:00",
    GIT_AUTHOR_NAME: "someone else",
  };
  const previous = new Map(Object.keys(hostile).map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const clean = await harness(t, "run-clean");
  const expected = (await clean.fixtures.materialize(FIXTURE)).baseCommit;

  for (const [name, value] of Object.entries(hostile)) process.env[name] = value;
  const polluted = await harness(t, "run-polluted");

  assert.equal(
    (await polluted.fixtures.materialize(FIXTURE)).baseCommit,
    expected,
    "an inherited GIT_* variable reached the fixture repository",
  );
});

test("a run root the manager did not create is never removed by it", async (t) => {
  const { root, fixtures } = await harness(t);
  const borrowed = new GitWorktreeManager("run-0003", root, { fixtures });

  const disposal = await borrowed.dispose();

  assert.equal(disposal.removed, false);
  assert.match(disposal.reason, /^not-owned:/);
  assert.ok(await exists(root.path));
});

test("a scenario id that is not a safe identifier never reaches Git", async (t) => {
  const { manager, issued } = await harness(t);
  await assert.rejects(
    manager.create({ scenarioId: "../escape", fixturePath: FIXTURE }),
    UnsafeIdentifierError,
  );
  assert.deepEqual(issued, [], "an unsafe identifier was allowed to reach a Git command");
});

test("a whole sample lifecycle issues no force argument and no destructive subcommand", async (t) => {
  const { manager, issued } = await harness(t);
  const worktree = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  await performWork(worktree);
  await manager.capture(worktree);
  await manager.cleanupIsolated(worktree);
  await manager.reclaimAbandoned();

  assert.ok(issued.length > 0, "the lifecycle issued no Git commands at all");
  for (const args of issued) {
    const subcommand = args[0] ?? "";
    assert.ok(
      (ALLOWED_GIT_SUBCOMMANDS as readonly string[]).includes(subcommand),
      `"git ${args.join(" ")}" is outside the allowlist`,
    );
    for (const argument of args) {
      assert.ok(
        !argument.startsWith("--force") && !["-f", "-D", "--hard"].includes(argument),
        `"git ${args.join(" ")}" carries a force argument`,
      );
    }
  }
});

// 2026-08-22, pirmas mokamas `ag-loop` bėgimas: 45 % celių iškrito su
// `stdout maxBuffer length exceeded`, nes vykdymo agentas įsidiegė savo Python runtime į
// PROCESO darbinį katalogą — matuojamą scenarijaus kopiją — ir `capture` tai užcommit'ino.
// Išgyvenusios celės buvo ne geresnės: jų `outOfScopeFiles` aprašinėjo įrankių grandinę, ne
// atliktą darbą. Matavimas privalo gintis pats, o ne tikėtis, kad kiekvienas host'o įrankis
// laikysis savo vietos.
test("įrankių grandinės keliai nepatenka nei į changedFiles, nei į diff'ą", async (t) => {
  const { manager } = await harness(t);
  const worktree = await manager.create({ scenarioId: "docs-add-page", fixturePath: FIXTURE });
  await performWork(worktree);

  // Tikras vykdymo pėdsakas: 3.14-64 runtime medis ir įdiegtos priklausomybės.
  for (const relative of ["Python/_cache/pythoncore.zip", "node_modules/lib/index.js", ".venv/pyvenv.cfg"]) {
    const target = path.join(worktree.path, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "SVETIMAS ĮRANKIŲ TURINYS\n", "utf8");
  }

  const capture = await manager.capture(worktree);

  assert.deepEqual(
    capture.changedFiles,
    [FIXTURE_FILE, "docs/new-page.md"],
    "įrankių keliai turi būti nematomi matavimui",
  );
  assert.doesNotMatch(capture.diff.text, /SVETIMAS ĮRANKIŲ TURINYS/);
  assert.doesNotMatch(capture.diff.text, /pythoncore/);
  // Scenarijaus darbas lieka matomas — išimtis yra siaura, o ne diff'o išjungimas.
  assert.match(capture.diff.text, /\+# new page/);
});
