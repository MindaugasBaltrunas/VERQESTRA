import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeWorkspaceFileWriter } from "../infrastructure/adapters/node-workspace-file-writer.js";

/**
 * Containment of the deterministic control's script (BENCH-4).
 *
 * A control script is configuration, and configuration is treated here the way
 * scenario data is: as input that must not decide what the harness touches. The
 * cases below are the three ways out of a checkout, and the last one is the
 * reason the check is made against a real path rather than a resolved string —
 * `path.resolve` cannot see a symbolic link, and a fixture may contain one.
 */

async function withCheckout(
  body: (root: string, writer: NodeWorkspaceFileWriter) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), "ag-benchmark-writer-"));
  try {
    const root = path.join(base, "checkout");
    await mkdir(path.join(root, ".git"), { recursive: true });
    await body(root, new NodeWorkspaceFileWriter());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("an edit inside the checkout is written, creating the directories it needs", async () => {
  await withCheckout(async (root, writer) => {
    const written = await writer.apply(root, [
      { path: "docs/guides/new-page.md", contents: "# new page\n" },
      { path: "docs/index.md", contents: "# index\n" },
    ]);

    assert.deepEqual(written, ["docs/guides/new-page.md", "docs/index.md"]);
    assert.equal(await readFile(path.join(root, "docs/guides/new-page.md"), "utf8"), "# new page\n");
    assert.equal(await readFile(path.join(root, "docs/index.md"), "utf8"), "# index\n");
  });
});

test("an existing file is overwritten and reported once", async () => {
  await withCheckout(async (root, writer) => {
    await writeFile(path.join(root, "notes.md"), "old\n", "utf8");
    const written = await writer.apply(root, [
      { path: "notes.md", contents: "first\n" },
      { path: "notes.md", contents: "second\n" },
    ]);

    assert.deepEqual(written, ["notes.md"]);
    assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "second\n");
  });
});

test("a path that climbs out of the checkout is refused", async () => {
  await withCheckout(async (root, writer) => {
    for (const escape of ["../escaped.md", "docs/../../escaped.md", "./.."]) {
      await assert.rejects(
        writer.apply(root, [{ path: escape, contents: "x" }]),
        /leaves the isolated checkout/,
        `"${escape}" was accepted`,
      );
    }
  });
});

test("an absolute path is refused rather than resolved", async () => {
  await withCheckout(async (root, writer) => {
    for (const absolute of ["/etc/passwd", "C:\\Windows\\System32\\drivers\\etc\\hosts"]) {
      await assert.rejects(
        writer.apply(root, [{ path: absolute, contents: "x" }]),
        /the path is absolute/,
        `"${absolute}" was accepted`,
      );
    }
  });
});

test("an empty path or one carrying a NUL byte is refused", async () => {
  await withCheckout(async (root, writer) => {
    await assert.rejects(writer.apply(root, [{ path: "  ", contents: "x" }]), /the path is empty/);
    await assert.rejects(
      writer.apply(root, [{ path: "docs/a\0b.md", contents: "x" }]),
      /NUL byte/,
    );
  });
});

test("writing into .git is refused: it holds the history the sample is measured against", async () => {
  await withCheckout(async (root, writer) => {
    for (const inside of [".git/config", ".git/hooks/pre-commit", "docs/../.git/HEAD"]) {
      await assert.rejects(
        writer.apply(root, [{ path: inside, contents: "x" }]),
        /inside \.git/,
        `"${inside}" was accepted`,
      );
    }
  });
});

test("a symbolic link out of the checkout is refused, whether it is the target or a parent", async (t) => {
  await withCheckout(async (root, writer) => {
    const outside = path.join(root, "..", "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.md"), "untouched\n", "utf8");

    try {
      await symlink(outside, path.join(root, "linked-directory"), "junction");
      await symlink(path.join(outside, "secret.md"), path.join(root, "linked-file"), "file");
    } catch {
      // Creating a link needs a privilege that is not always granted on Windows;
      // skipping is honest, and asserting nothing would silently drop the case.
      t.skip("this host does not permit creating symbolic links");
      return;
    }

    await assert.rejects(
      writer.apply(root, [{ path: "linked-directory/planted.md", contents: "x" }]),
      /leaves the isolated checkout/,
      "a linked directory let a write land outside the checkout",
    );
    await assert.rejects(
      writer.apply(root, [{ path: "linked-file", contents: "x" }]),
      /symbolic link/,
      "a linked file let a write land outside the checkout",
    );
    assert.equal(await readFile(path.join(outside, "secret.md"), "utf8"), "untouched\n");
  });
});

test("a target that exists and is not a file is refused rather than written over", async () => {
  await withCheckout(async (root, writer) => {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await assert.rejects(
      writer.apply(root, [{ path: "docs", contents: "x" }]),
      /exists and is not a file/,
    );
  });
});
