// VQ-304 (1 dalis): pagalbinių task-execution use case'ų unit testai su fake portais —
// run state konstrukcija, eilės parinkimas, pre-dispatch work-evidence vartai, retry/repair
// sprendimas, human-review eskalacija ir auto-OpenSpec archyvavimas. Jokios realios FS/git.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createTaskRunState } from "../application/task-execution/task-run-state.js";
import { selectNextQueuedTaskFile, selectNextResumableTask } from "../application/task-execution/task-selection.js";
import { confirmSkippedDispatch, probeWorkEvidence } from "../application/task-execution/skip-dispatch.js";
import { decideRetryOrRepair, type RetryRepairPorts } from "../application/task-execution/retry-repair.js";
import { decideHumanReviewEscalation } from "../application/task-execution/human-review-escalation.js";
import {
  archiveAutoOpenSpecChangeOnDone,
  resolveAutoChangeForTask,
  type OpenSpecArchiveFsPort,
} from "../application/task-execution/openspec-archive.js";
import { analyzeHumanReviewGates } from "../domain/tasks/index.js";
import { createFakeTaskRunEnv, fakeBucketPath } from "./helpers/fake-task-run-ports.js";

const TASK = "0042";
const TASK_MD = `${TASK}.md`;

test("createTaskRunState: snapshot, fingerprint, interrupted bucket'o failo perėmimas", async () => {
  const env = createFakeTaskRunEnv();
  const errorFile = fakeBucketPath("error", TASK_MD);
  env.files.set(errorFile, "# Task\nkūnas");
  const state = await createTaskRunState(errorFile, env.ports, { interrupted: true });
  assert.equal(state.taskId, TASK);
  assert.equal(state.taskName, TASK_MD);
  assert.equal(state.taskBodySnapshot, "# Task\nkūnas");
  assert.equal(state.errorFile, errorFile, "interrupted error bucket'e perima taskFile kelią");
  assert.equal(state.activeFile, fakeBucketPath("active", TASK_MD));
  assert.equal(await state.resolveCurrentTaskFile(), errorFile, "pirmas egzistuojantis iš [active,error,delegated]");
  assert.equal(state.remember("/kitas/kelias.md"), "/kitas/kelias.md");
  assert.ok(state.knownTaskFiles.has("/kitas/kelias.md"));
});

test("createTaskRunState: neperskaitomas failas nestabdo run'o — snapshot undefined", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = fakeBucketPath("queue", TASK_MD);
  const state = await createTaskRunState(queuedFile, env.ports);
  assert.equal(state.taskBodySnapshot, undefined);
  assert.equal(await state.resolveCurrentTaskFile(), state.activeFile, "nė vieno nėra — krenta į activeFile");
});

test("task-selection: resumable bucket'ai pagal prioritetą, tada queue", async () => {
  const listings = new Map<string, string[]>();
  const bucketKey = (bucket: string) => path.join("/repo/AG", "tasks", bucket);
  const ports = { listMarkdownFilePaths: async (dir: string) => listings.get(dir) ?? [] };
  assert.equal(await selectNextResumableTask("/repo/AG", ports), undefined);

  listings.set(bucketKey("error"), ["/repo/AG/tasks/error/0002.md"]);
  listings.set(bucketKey("delegated"), ["/repo/AG/tasks/delegated/0001.md"]);
  const picked = await selectNextResumableTask("/repo/AG", ports);
  assert.deepEqual(picked, { bucket: "delegated", file: "/repo/AG/tasks/delegated/0001.md" }, "delegated > error");

  listings.set(bucketKey("queue"), ["/repo/AG/tasks/queue/0009.md", "/repo/AG/tasks/queue/0010.md"]);
  assert.equal(await selectNextQueuedTaskFile("/repo/AG", ports), "/repo/AG/tasks/queue/0009.md");
});

test("probeWorkEvidence: be įrodymo git status net neklausiamas (nulinis pėdsakas)", async () => {
  const env = createFakeTaskRunEnv();
  const file = fakeBucketPath("queue", TASK_MD);
  env.files.set(file, "x");
  const state = await createTaskRunState(file, env.ports);

  env.behavior.git.isRepository = false;
  assert.deepEqual(await probeWorkEvidence(state, env.ports), { kind: "dispatch", reason: "not-a-git-repository" });

  env.behavior.git.isRepository = true;
  let dirtyAsked = false;
  const originalDirty = env.ports.git.productDirtyCount.bind(env.ports.git);
  env.ports.git.productDirtyCount = async () => {
    dirtyAsked = true;
    return 0;
  };
  assert.deepEqual(await probeWorkEvidence(state, env.ports), { kind: "dispatch", reason: "no-work-evidence" });
  assert.equal(dirtyAsked, false, "be commit'o productDirtyCount neiškviečiamas");
  assert.equal(env.logs.length, 0, "be įrodymo — jokios log eilutės");

  env.ports.git.productDirtyCount = originalDirty;
  env.behavior.git.committedProductWorkSha = "abc123";
  assert.deepEqual(await probeWorkEvidence(state, env.ports), { kind: "skip", commit: "abc123" });
});

test("confirmSkippedDispatch: žali gates → already-implemented; raudoni → dispatch; infra → abort", async () => {
  const env = createFakeTaskRunEnv();
  const file = fakeBucketPath("queue", TASK_MD);
  env.files.set(file, "x");
  const state = await createTaskRunState(file, env.ports);

  env.behavior.cli = () => 0;
  const ok = await confirmSkippedDispatch(state, env.ports, "abc123");
  assert.deepEqual(ok, { kind: "already-implemented", commit: "abc123" });
  assert.match(env.journalEvents.at(-1)?.reason ?? "", /dispatch_skipped=1 commit=abc123/);

  env.behavior.cli = () => 1;
  const rejected = await confirmSkippedDispatch(state, env.ports, "abc123");
  assert.deepEqual(rejected, { kind: "dispatch", qualityGateExit: 1 });
  assert.match(env.journalEvents.at(-1)?.reason ?? "", /skip_dispatch_rejected/);

  env.behavior.cli = () => 78;
  const infra = await confirmSkippedDispatch(state, env.ports, "abc123");
  assert.deepEqual(infra, { kind: "infrastructure", exitCode: 78 });
  assert.equal(env.phaseFailures.at(-1)?.phase, "quality-gates");
});

test("decideRetryOrRepair: limitas → human-review; be prompt'o → human-review; kitaip retry", async () => {
  const makePorts = (count: number, prompt: string): RetryRepairPorts => ({
    incrementRetryCount: async () => count,
    readRepairPrompt: async () => prompt,
  });
  const limit = await decideRetryOrRepair({ taskId: TASK, retryKey: "k", maxAttempts: 3 }, makePorts(3, "yra"));
  assert.equal(limit.outcome, "human-review");
  assert.equal(limit.reason, "maximum retry attempts reached");

  const noPrompt = await decideRetryOrRepair({ taskId: TASK, retryKey: "k", maxAttempts: 3 }, makePorts(1, "  "));
  assert.equal(noPrompt.outcome, "human-review");
  assert.equal(noPrompt.reason, "task_scoped_repair_prompt_missing");

  const retry = await decideRetryOrRepair({ taskId: TASK, retryKey: "k", maxAttempts: 3 }, makePorts(1, "# Repair"));
  assert.equal(retry.outcome, "retry");
  assert.equal(retry.repairPrompt, "# Repair");
});

test("decideHumanReviewEscalation: gate'ai iš domain taisyklės virsta dviejų šakų baigtimi", async () => {
  const ports = {
    analyzeGates: async (taskFile: string) =>
      analyzeHumanReviewGates(taskFile.includes("risky") ? "# Task\n## Tikslas\nRotate jwt secrets." : "# Task\n## Tikslas\nRefactor docs."),
  };
  const risky = await decideHumanReviewEscalation({ taskFile: "/tasks/risky.md" }, ports);
  assert.equal(risky.outcome, "human-review");
  assert.ok(risky.reason.length > 0);

  const safe = await decideHumanReviewEscalation({ taskFile: "/tasks/safe.md" }, ports);
  assert.equal(safe.outcome, "no-escalation");
});

function fakeArchiveFs(initial: Record<string, string>, dirs: Set<string>): {
  fs: OpenSpecArchiveFsPort;
  files: Map<string, string>;
  dirs: Set<string>;
  renames: [string, string][];
} {
  const files = new Map(Object.entries(initial));
  const renames: [string, string][] = [];
  const norm = (p: string) => p.replace(/\\/g, "/");
  const fs: OpenSpecArchiveFsPort = {
    exists: async (p) => files.has(norm(p)) || dirs.has(norm(p)),
    readTextFileIfExists: async (p) => files.get(norm(p)),
    writeTextFileAtomic: async (p, content) => void files.set(norm(p), content),
    makeDirectory: async (p) => void dirs.add(norm(p)),
    rename: async (from, to) => {
      renames.push([norm(from), norm(to)]);
      dirs.delete(norm(from));
      dirs.add(norm(to));
    },
  };
  return { fs, files, dirs, renames };
}

test("resolveAutoChangeForTask: nuoroda tekste > slug rekonstrukcija; kelios nuorodos = ambiguous", async () => {
  const { fs } = fakeArchiveFs({}, new Set(["/ag/openspec/changes/auto-0042-fix"]));
  const bySpec = await resolveAutoChangeForTask(fs, "/ag", TASK, "žr. openspec/changes/auto-0042-fix/spec.md");
  assert.deepEqual(bySpec, { kind: "match", slug: "auto-0042-fix", source: "spec-source" });

  const ambiguous = await resolveAutoChangeForTask(fs, "/ag", TASK, "openspec/changes/auto-a ir openspec/changes/auto-b");
  assert.equal(ambiguous.kind, "ambiguous");

  const { fs: fsKnown } = fakeArchiveFs({}, new Set(["/ag/openspec/changes/auto-0042"]));
  const reconstructed = await resolveAutoChangeForTask(fsKnown, "/ag", TASK, "");
  assert.deepEqual(reconstructed, { kind: "match", slug: "auto-0042", source: "slug-reconstruction" });

  const { fs: fsEmpty } = fakeArchiveFs({}, new Set());
  assert.deepEqual(await resolveAutoChangeForTask(fsEmpty, "/ag", TASK, ""), { kind: "none" });
});

test("archiveAutoOpenSpecChangeOnDone: tasks.md pažymimas PRIEŠ perkėlimą; idempotencija; kolizija", async () => {
  const dirs = new Set(["/ag/openspec/changes/auto-0042"]);
  const { fs, files, renames } = fakeArchiveFs(
    {
      "/ag/tasks/done/0042.md": "žr. openspec/changes/auto-0042",
      "/ag/openspec/changes/auto-0042/tasks.md": "- [ ] vienas\n- [x] du\n",
    },
    dirs,
  );
  const outcome = await archiveAutoOpenSpecChangeOnDone(fs, "/ag", TASK, "/ag/tasks/done/0042.md");
  assert.deepEqual(outcome, { action: "archived", changeDir: "openspec/changes/auto-0042", markedTaskLines: 1 });
  assert.equal(files.get("/ag/openspec/changes/auto-0042/tasks.md"), "- [x] vienas\n- [x] du\n");
  assert.deepEqual(renames, [["/ag/openspec/changes/auto-0042", "/ag/openspec/changes/archive/auto-0042"]]);

  // Pakartotinis uždarymas: aktyvaus nebėra, archyvas yra → already-archived, nieko nerašo.
  const again = await archiveAutoOpenSpecChangeOnDone(fs, "/ag", TASK, "/ag/tasks/done/0042.md");
  assert.deepEqual(again, { action: "already-archived", changeDir: "openspec/changes/auto-0042" });

  // Kolizija: ir aktyvus, ir archyvas → error be jokio rename.
  dirs.add("/ag/openspec/changes/auto-0042");
  const collision = await archiveAutoOpenSpecChangeOnDone(fs, "/ag", TASK, "/ag/tasks/done/0042.md");
  assert.deepEqual(collision, {
    action: "error",
    changeDir: "openspec/changes/auto-0042",
    reason: "archive-target-exists",
  });
  assert.equal(renames.length, 1, "kolizijoje rename nevyksta");
});

test("archiveAutoOpenSpecChangeOnDone: niekada nemeta — FS klaida virsta error baigtimi", async () => {
  const fs: OpenSpecArchiveFsPort = {
    exists: async () => {
      throw new Error("disk on fire");
    },
    readTextFileIfExists: async () => "openspec/changes/auto-x",
    writeTextFileAtomic: async () => {},
    makeDirectory: async () => {},
    rename: async () => {},
  };
  const outcome = await archiveAutoOpenSpecChangeOnDone(fs, "/ag", TASK, "/done/0042.md");
  assert.equal(outcome.action, "error");
  assert.match((outcome as { reason: string }).reason, /disk on fire/);
});
