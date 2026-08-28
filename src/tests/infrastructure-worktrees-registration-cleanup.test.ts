// Vienetiniai testai `cleanupWorktreeRegistrations` primityvui — GeoGravity 1179: negyva
// `.git/worktrees/<name>/` registracija su pakibusiu `index.lock` neturi blokuoti kitų git
// operacijų. Čia tikrinama tik pati funkcija (fs skenavimas + amžiaus slenkstis), be realaus
// `git worktree add` — struktūra sukuriama rankomis, kad testas liktų greitas ir determinuotas.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { CommandResult } from "../infrastructure/process/run-process.js";
import { cleanupWorktreeRegistrations } from "../infrastructure/git/worktrees/worktree-registration-cleanup.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeProjectRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "vq-wt-reg-cleanup-"));
  roots.push(root);
  mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function makeRegistration(
  root: string,
  name: string,
  options: { gitdirTarget?: string; lockAgeMs?: number } = {},
): string {
  const registrationDir = path.join(root, ".git", "worktrees", name);
  mkdirSync(registrationDir, { recursive: true });
  if (options.gitdirTarget !== undefined) {
    writeFileSync(path.join(registrationDir, "gitdir"), options.gitdirTarget);
  }
  if (options.lockAgeMs !== undefined) {
    const lockPath = path.join(registrationDir, "index.lock");
    writeFileSync(lockPath, "");
    const past = new Date(Date.now() - options.lockAgeMs);
    utimesSync(lockPath, past, past);
  }
  return registrationDir;
}

function fakeRunner(result: Partial<CommandResult> = {}): {
  runner: () => Promise<CommandResult>;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const runner = (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...result });
  };
  return { runner, calls };
}

test("gyva registracija: index.lock (net pasenęs) neliečiamas", async () => {
  const root = makeProjectRoot();
  const liveGitdir = path.join(root, "live-worktree", ".git");
  mkdirSync(liveGitdir, { recursive: true });
  const registrationDir = makeRegistration(root, "live", {
    gitdirTarget: liveGitdir,
    lockAgeMs: 60_000,
  });
  const { runner } = fakeRunner();

  const result = await cleanupWorktreeRegistrations({ projectRoot: root, runner });

  assert.deepEqual(result.deadRegistrations, []);
  assert.deepEqual(result.removedLocks, []);
  assert.ok(existsSync(path.join(registrationDir, "index.lock")));
});

test("negyva registracija su šviežiu lock'u: lock paliekamas, bet registracija pažymima negyva", async () => {
  const root = makeProjectRoot();
  const registrationDir = makeRegistration(root, "dead-fresh-lock", {
    gitdirTarget: path.join(root, "gone-worktree", ".git"),
    lockAgeMs: 100,
  });
  const { runner } = fakeRunner();

  const result = await cleanupWorktreeRegistrations({ projectRoot: root, runner });

  assert.deepEqual(result.deadRegistrations, ["dead-fresh-lock"]);
  assert.deepEqual(result.removedLocks, []);
  assert.ok(existsSync(path.join(registrationDir, "index.lock")));
});

test("negyva registracija su pasenusiu lock'u: lock pašalinamas", async () => {
  const root = makeProjectRoot();
  const registrationDir = makeRegistration(root, "dead-stale-lock", {
    gitdirTarget: path.join(root, "gone-worktree", ".git"),
    lockAgeMs: 60_000,
  });
  const { runner } = fakeRunner();

  const result = await cleanupWorktreeRegistrations({ projectRoot: root, runner });

  assert.deepEqual(result.deadRegistrations, ["dead-stale-lock"]);
  assert.deepEqual(result.removedLocks, ["dead-stale-lock"]);
  assert.equal(existsSync(path.join(registrationDir, "index.lock")), false);
});

test("be .git/worktrees arba be lock'ų: tušti masyvai, prune vis tiek iškviestas", async () => {
  const root = makeProjectRoot();
  const { runner, calls } = fakeRunner();

  const result = await cleanupWorktreeRegistrations({ projectRoot: root, runner });

  assert.deepEqual(result.deadRegistrations, []);
  assert.deepEqual(result.removedLocks, []);
  assert.equal(result.pruneResult.code, 0);
  assert.deepEqual(calls[0]?.[1], ["-C", root, "worktree", "prune"]);
});

test("runner meta klaidą: funkcija nemeta, pruneResult atspindi nesėkmę", async () => {
  const root = makeProjectRoot();
  makeRegistration(root, "dead-no-lock", { gitdirTarget: path.join(root, "gone", ".git") });
  const runner = () => Promise.reject(new Error("spawn ENOENT"));

  const result = await cleanupWorktreeRegistrations({ projectRoot: root, runner });

  assert.deepEqual(result.deadRegistrations, ["dead-no-lock"]);
  assert.equal(result.pruneResult.code, -1);
  assert.match(result.pruneResult.stderr, /ENOENT/);
});

test("registracija be gitdir failo: nelaikoma negyva", async () => {
  const root = makeProjectRoot();
  makeRegistration(root, "no-gitdir-file");
  const { runner } = fakeRunner();

  const result = await cleanupWorktreeRegistrations({ projectRoot: root, runner });

  assert.deepEqual(result.deadRegistrations, []);
  assert.deepEqual(result.removedLocks, []);
});

test("gitdir failas su tuščiu turiniu: nelaikoma negyva", async () => {
  const root = makeProjectRoot();
  makeRegistration(root, "empty-gitdir", { gitdirTarget: "" });
  const { runner } = fakeRunner();

  const result = await cleanupWorktreeRegistrations({ projectRoot: root, runner });

  assert.deepEqual(result.deadRegistrations, []);
  assert.deepEqual(result.removedLocks, []);
});

test("ne-katalogo įrašas .git/worktrees viduje: praleidžiamas be klaidos", async () => {
  const root = makeProjectRoot();
  const worktreesDir = path.join(root, ".git", "worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  writeFileSync(path.join(worktreesDir, "stray-file"), "not a registration");
  const { runner } = fakeRunner();

  const result = await cleanupWorktreeRegistrations({ projectRoot: root, runner });

  assert.deepEqual(result.deadRegistrations, []);
  assert.deepEqual(result.removedLocks, []);
  assert.equal(result.error, undefined);
});

test("skenavimas meta klaidą (worktrees kelias yra failas, ne katalogas): error laukas užpildomas, funkcija nemeta", async () => {
  const root = makeProjectRoot();
  writeFileSync(path.join(root, ".git", "worktrees"), "not a directory");
  const { runner } = fakeRunner();

  const result = await cleanupWorktreeRegistrations({ projectRoot: root, runner });

  assert.deepEqual(result.deadRegistrations, []);
  assert.deepEqual(result.removedLocks, []);
  assert.equal(typeof result.error, "string");
  assert.equal(result.pruneResult.code, 0);
});

test("keli irasai vienu metu: gyva ir dvi negyvos registracijos apdorojamos nepriklausomai", async () => {
  const root = makeProjectRoot();
  const liveGitdir = path.join(root, "live-worktree", ".git");
  mkdirSync(liveGitdir, { recursive: true });
  makeRegistration(root, "live-mix", { gitdirTarget: liveGitdir, lockAgeMs: 60_000 });
  makeRegistration(root, "dead-fresh-mix", {
    gitdirTarget: path.join(root, "gone-fresh", ".git"),
    lockAgeMs: 100,
  });
  const staleDir = makeRegistration(root, "dead-stale-mix", {
    gitdirTarget: path.join(root, "gone-stale", ".git"),
    lockAgeMs: 60_000,
  });
  const { runner } = fakeRunner();

  const result = await cleanupWorktreeRegistrations({ projectRoot: root, runner });

  assert.deepEqual(result.deadRegistrations.sort(), ["dead-fresh-mix", "dead-stale-mix"]);
  assert.deepEqual(result.removedLocks, ["dead-stale-mix"]);
  assert.equal(existsSync(path.join(staleDir, "index.lock")), false);
});
