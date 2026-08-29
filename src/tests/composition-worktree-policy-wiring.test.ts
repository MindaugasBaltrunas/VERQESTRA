// Worktree `.gitignore` dengimo porto (`WavesViewPorts.readWorktreeGitignoreOk`) surišimas su
// tikru fs (088-b-03). Vertimo logika (kada laukas rodomas/praleidžiamas/degraduoja) jau padengta
// `interfaces-http-waves-view.test.ts` su pin'intais mock portais — čia tikrinamas TIK adapteris:
// ar jis realiai skaito PROJEKTO `.gitignore` ir teisingai atpažįsta worktree eilutę.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { uiRouterPorts } from "../composition/ui/router-adapters.js";

type Sandbox = { projectRoot: string; runtimeRoot: string; agRoot: string };

type WavesViewWithWorktreePolicy = {
  worktree_policy?: { worktree_gitignore_ok?: boolean };
  degraded: string[];
};

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-worktree-gitignore-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  const agRoot = path.join(projectRoot, "AG");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(agRoot, { recursive: true });
  return { projectRoot, runtimeRoot, agRoot };
}

async function readWavesView(sandbox: Sandbox): Promise<WavesViewWithWorktreePolicy> {
  const ports = uiRouterPorts({ ...sandbox, logError: () => {} });
  return (await ports.wavesView(50)) as WavesViewWithWorktreePolicy;
}

async function readGitignoreOkField(sandbox: Sandbox): Promise<boolean | undefined> {
  const view = await readWavesView(sandbox);
  return view.worktree_policy?.worktree_gitignore_ok;
}

test("readWorktreeGitignoreOk surišimas: .gitignore turi worktree eilutę -> true", async () => {
  const sandbox = await makeSandbox();
  try {
    await writeFile(path.join(sandbox.projectRoot, ".gitignore"), "node_modules/\n.ag/worktrees/\n", "utf8");

    const okField = await readGitignoreOkField(sandbox);
    assert.equal(okField, true);
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("readWorktreeGitignoreOk surišimas: .gitignore be worktree eilutės -> false", async () => {
  const sandbox = await makeSandbox();
  try {
    await writeFile(path.join(sandbox.projectRoot, ".gitignore"), "node_modules/\ndist/\n", "utf8");

    const okField = await readGitignoreOkField(sandbox);
    assert.equal(okField, false);
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("readWorktreeGitignoreOk surišimas: nesantis .gitignore -> false, ne klaida", async () => {
  const sandbox = await makeSandbox();
  try {
    // Jokio .gitignore failo projekto šaknyje.
    const view = await readWavesView(sandbox);

    assert.equal(view.worktree_policy?.worktree_gitignore_ok, false);
    assert.ok(!view.degraded.includes("worktree_gitignore"), "nesantis failas nėra degradavimas");
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});
