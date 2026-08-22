import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  WorkspaceFileEdit,
  WorkspaceFilePort,
} from "../../application/ports/workspace-file-port.js";

/**
 * Applies the deterministic control's script to an isolated checkout.
 *
 * The whole of the interesting behaviour here is refusal. A control script is
 * configuration, and configuration in this package is treated the way scenario
 * data is: as input that must not be able to decide what the harness touches.
 * Three ways out of a checkout are closed explicitly, because each one looks
 * harmless in isolation and none of them would be noticed in the results:
 *
 * - A **parent segment or an absolute path** — the obvious one, and the only one
 *   a path string alone reveals.
 * - A **symbolic link** anywhere along the resolved directory — a fixture may
 *   contain one, and `path.resolve` cannot see it. The containment check is
 *   therefore made against the *real* path, after the directories exist.
 * - **`.git`** — inside the checkout, but writing there rewrites the very history
 *   the sample's start and end commits are read from, so the isolation evidence
 *   would describe a repository the control had edited.
 */

/** Raised for an edit this package will not apply. */
export class WorkspaceWriteRefusedError extends Error {
  constructor(editPath: string, reason: string) {
    super(`Refused to write "${editPath}": ${reason}.`);
    this.name = "WorkspaceWriteRefusedError";
  }
}

function assertWritablePath(editPath: string): void {
  if (editPath.trim() === "") {
    throw new WorkspaceWriteRefusedError(editPath, "the path is empty");
  }
  if (editPath.includes("\0")) {
    throw new WorkspaceWriteRefusedError(editPath, "the path carries a NUL byte");
  }
  if (path.isAbsolute(editPath) || path.win32.isAbsolute(editPath)) {
    throw new WorkspaceWriteRefusedError(editPath, "the path is absolute");
  }
}

/** Checkout-relative POSIX form of `target`, or a refusal when it is not inside `root`. */
function containedRelativePath(root: string, target: string, editPath: string): string {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceWriteRefusedError(editPath, "the path leaves the isolated checkout");
  }
  const posix = relative.split(path.sep).join("/");
  if (posix === ".git" || posix.startsWith(".git/")) {
    throw new WorkspaceWriteRefusedError(
      editPath,
      "the path is inside .git, which holds the history the sample is measured against",
    );
  }
  return posix;
}

export class NodeWorkspaceFileWriter implements WorkspaceFilePort {
  async apply(
    worktreePath: string,
    edits: readonly WorkspaceFileEdit[],
  ): Promise<readonly string[]> {
    // The checkout's own real path, so a temporary directory that is itself a
    // symbolic link — which is the default on macOS — does not read as an escape.
    const root = await realpath(path.resolve(worktreePath));
    const written: string[] = [];

    for (const edit of edits) {
      assertWritablePath(edit.path);
      const target = path.resolve(root, edit.path);
      const relative = containedRelativePath(root, target, edit.path);

      const directory = path.dirname(target);
      await mkdir(directory, { recursive: true });
      // Re-checked after the directories exist: until now the containment was a
      // property of the strings, and a link in the fixture would have made it a
      // property of nothing.
      containedRelativePath(root, path.join(await realpath(directory), path.basename(target)), edit.path);

      const existing = await lstat(target).catch(() => undefined);
      if (existing?.isSymbolicLink() === true) {
        // `writeFile` would follow it and write wherever it points.
        throw new WorkspaceWriteRefusedError(edit.path, "the target is a symbolic link");
      }
      if (existing?.isFile() === false) {
        throw new WorkspaceWriteRefusedError(edit.path, "the target exists and is not a file");
      }

      await writeFile(target, edit.contents, "utf8");
      written.push(relative);
    }

    return [...new Set(written)].sort();
  }
}
