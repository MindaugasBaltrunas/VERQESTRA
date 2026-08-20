// Stable-ref checkpoint'as (etalonas: AG_loop orchestrator/git/stable-ref.ts). VERQESTRA
// keliai: vq/state/stable-ref + vq/logs/commit.log. SHA taisyklė — domain/git.

import path from "node:path";
import { isCommitSha } from "../../domain/git/rollback-rules.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { gitHead, isGitRepository, type GitExecutor } from "./git-client.js";

export type StableRefResult =
  | { status: "ok"; ref: string }
  | { status: "missing"; message: string }
  | { status: "invalid"; value: string; message: string };

export function stableRefPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "stable-ref");
}

export async function loadStableRef(filePath: string): Promise<StableRefResult> {
  const raw = await nodeFsAdapter.readTextFileIfExists(filePath);
  if (raw === undefined) {
    return { status: "missing", message: `Stable reference is missing: ${filePath}` };
  }
  const value = raw.trim();
  if (!isCommitSha(value)) {
    return { status: "invalid", value, message: `Invalid stable reference in ${filePath}: expected a commit SHA` };
  }
  return { status: "ok", ref: value.toLowerCase() };
}

export async function saveStableRef(filePath: string, ref: string): Promise<StableRefResult> {
  const normalized = ref.trim().toLowerCase();
  if (!isCommitSha(normalized)) {
    return { status: "invalid", value: ref, message: "Invalid stable reference: expected a commit SHA" };
  }
  await nodeFsAdapter.writeTextFile(filePath, `${normalized}\n`);
  return { status: "ok", ref: normalized };
}

export async function checkpointStableRef(projectRoot: string, filePath: string, execute?: GitExecutor): Promise<StableRefResult> {
  const head = execute === undefined ? await gitHead(projectRoot) : await gitHead(projectRoot, execute);
  if (!head) return { status: "missing", message: `Cannot read git HEAD for ${projectRoot}` };
  return await saveStableRef(filePath, head);
}

export async function markStableIfSuccess(projectRoot: string, runtimeRoot: string): Promise<void> {
  if (!(await isGitRepository(projectRoot))) return;
  const result = await checkpointStableRef(projectRoot, stableRefPath(runtimeRoot));
  if (result.status !== "ok") return;
  await nodeFsAdapter.appendTextFile(
    path.join(runtimeRoot, "logs", "commit.log"),
    `[${new Date().toISOString()}] stable_ref=${result.ref}\n`,
  );
}
