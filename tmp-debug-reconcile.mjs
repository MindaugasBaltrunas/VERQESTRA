import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nodeFsAdapter } from "./dist/infrastructure/fs/node-fs-adapter.js";
import { run } from "./dist/infrastructure/process/run-process.js";
import { gitHead } from "./dist/infrastructure/git/git-client.js";
import { PRESERVED_REF_PREFIX } from "./dist/infrastructure/git/rollback-scope.js";
import { reconcilePreservedRefs, parseTaskIdFromCommitMessage } from "./dist/infrastructure/git/preserved-ref-reconcile.js";

const root = await mkdtemp(path.join(tmpdir(), "vq-debug-"));
const runtimeRoot = path.join(root, "vq");
async function git(...args) {
  const result = await run("git", ["-C", root, ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr||result.stdout}`);
  return result;
}
await git("init");
await git("config", "user.email", "test@example.com");
await git("config", "user.name", "Test");
await git("config", "commit.gpgsign", "false");
await git("config", "core.autocrlf", "false");
await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), "pradinis\n");
await git("add", "--all");
await git("commit", "-m", "pradinis");
const stable = await gitHead(root);

async function makePreservedRef(content, message) {
  await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), content);
  await git("add", "--all");
  const treeResult = await git("write-tree");
  const tree = treeResult.stdout.trim();
  await git("reset", "--hard", stable);
  const commitTreeResult = await git("commit-tree", tree, "-p", stable, "-m", message);
  const commit = commitTreeResult.stdout.trim();
  const ref = `${PRESERVED_REF_PREFIX}${commit}`;
  await git("update-ref", ref, commit);
  return ref;
}

const recordPath = path.join(runtimeRoot, "state", "rollback-preserved", "083-collision.json");
const original = JSON.stringify({ task_id: "083-collision", ref: "refs/verqestra/preserved/oldsha", commit: "oldsha", base_ref: stable, paths: ["old.ts"], recorded_at: "2020-01-01T00:00:00.000Z" }, null, 2);
await nodeFsAdapter.writeTextFile(recordPath, original);

const ref = await makePreservedRef("kolizija\n", "verqestra: preserved task scope task=083-collision");
console.log("ref:", ref);
console.log("exists targetPath before reconcile:", await nodeFsAdapter.exists(recordPath));

const msgResult = await run("git", ["-C", root, "log", "-1", "--format=%B", ref]);
console.log("raw commit message:", JSON.stringify(msgResult.stdout));
console.log("parsed task id:", parseTaskIdFromCommitMessage(msgResult.stdout));

const logs = [];
const result = await reconcilePreservedRefs(root, { agLog: async (line) => void logs.push(line) }, { runtimeRoot });
console.log(JSON.stringify(result, null, 2));
console.log("logs:", logs);

await rm(root, { recursive: true, force: true }).catch(() => undefined);
