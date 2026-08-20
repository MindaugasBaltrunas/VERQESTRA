// Bendri worktree modulių git primityvai (lifecycle skaidymo bendroji dalis).

import path from "node:path";
import { run, type CommandResult } from "../../process/run-process.js";
import type { GitWorktreeEntry } from "../git-client.js";

export async function worktreeGit(root: string, args: string[]): Promise<CommandResult> {
  return await run("git", ["-C", root, ...args], { cwd: root });
}

export function worktreeGitFailure(result: CommandResult, args: readonly string[]): string {
  return `git ${args.join(" ")} failed (code ${result.code}): ${(result.stderr || result.stdout).trim()}`;
}

export function entryFor(entries: readonly GitWorktreeEntry[], worktreePath: string): GitWorktreeEntry | undefined {
  const target = path.resolve(worktreePath);
  return entries.find((entry) => path.resolve(entry.path) === target);
}

export async function unmergedPathsIn(worktreePath: string): Promise<string[]> {
  const result = await worktreeGit(worktreePath, ["ls-files", "--unmerged"]);
  if (result.code !== 0) return [];
  return [
    ...new Set(
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.split("\t")[1]?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();
}
