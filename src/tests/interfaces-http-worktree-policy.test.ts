// Worktree politikos perjungimo modulis (AG 088): TIK `enabled` keičiasi JSON'e, o `.gitignore`
// liečiamas TIK įjungiant ir TIK jei trūksta `.ag/worktrees/` eilutės.

import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidWorktreePolicyConfigError,
  setWorktreePolicyEnabled,
  type WorktreePolicyPorts,
} from "../interfaces/http/ui-worktree-policy.js";

const RUNTIME_ROOT = "/repo/vq";
const PROJECT_ROOT = "/repo";

function baseConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ enabled: false, root: ".ag-worktrees", branchPrefix: "ag-task", ...overrides });
}

function makePorts(overrides: Partial<WorktreePolicyPorts> = {}): {
  ports: WorktreePolicyPorts;
  writtenConfig: { text?: string };
  writtenGitignore: { text?: string };
  logs: string[];
} {
  const writtenConfig: { text?: string } = {};
  const writtenGitignore: { text?: string } = {};
  const logs: string[] = [];
  const ports: WorktreePolicyPorts = {
    readConfigFile: async () => baseConfig(),
    writeConfigFile: async (_file, content) => {
      writtenConfig.text = content;
    },
    readGitignore: async () => undefined,
    writeGitignore: async (_file, content) => {
      writtenGitignore.text = content;
    },
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { ports, writtenConfig, writtenGitignore, logs };
}

test("setWorktreePolicyEnabled: enable be eilutės -> eilutė pridėta ir log gitignore=appended", async () => {
  const { ports, writtenConfig, writtenGitignore, logs } = makePorts({
    readGitignore: async () => "node_modules/\ndist/\n",
  });

  const result = await setWorktreePolicyEnabled(ports, {
    runtimeRoot: RUNTIME_ROOT,
    projectRoot: PROJECT_ROOT,
    enabled: true,
  });

  assert.deepEqual(result, { enabled: true, gitignore_ok: true });
  assert.match(writtenGitignore.text ?? "", /\.ag\/worktrees\/\n$/);
  assert.ok(writtenGitignore.text?.startsWith("node_modules/\ndist/\n\n"), "esamas turinys nekeičiamas");
  assert.equal(logs[0], "WORKTREE POLICY: enabled=true gitignore=appended");

  const writtenConfigJson = JSON.parse(writtenConfig.text ?? "{}");
  assert.equal(writtenConfigJson.enabled, true);
  assert.equal(writtenConfigJson.root, ".ag-worktrees", "kiti laukai išsaugomi");
});

test("setWorktreePolicyEnabled: enable su eilute -> .gitignore nepaliestas ir log gitignore=ok", async () => {
  let gitignoreWrites = 0;
  const { ports, logs } = makePorts({
    readGitignore: async () => "dist/\n\n.ag/worktrees/\n",
    writeGitignore: async () => {
      gitignoreWrites += 1;
    },
  });

  const result = await setWorktreePolicyEnabled(ports, {
    runtimeRoot: RUNTIME_ROOT,
    projectRoot: PROJECT_ROOT,
    enabled: true,
  });

  assert.deepEqual(result, { enabled: true, gitignore_ok: true });
  assert.equal(gitignoreWrites, 0, ".gitignore neturi būti rašomas, kai eilutė jau yra");
  assert.equal(logs[0], "WORKTREE POLICY: enabled=true gitignore=ok");
});

test("setWorktreePolicyEnabled: disable -> keičiasi tik enabled, .gitignore niekada neliečiamas", async () => {
  let gitignoreReads = 0;
  let gitignoreWrites = 0;
  const { ports, writtenConfig, logs } = makePorts({
    readConfigFile: async () => baseConfig({ enabled: true, pathPrefix: "task" }),
    readGitignore: async () => {
      gitignoreReads += 1;
      return undefined;
    },
    writeGitignore: async () => {
      gitignoreWrites += 1;
    },
  });

  const result = await setWorktreePolicyEnabled(ports, {
    runtimeRoot: RUNTIME_ROOT,
    projectRoot: PROJECT_ROOT,
    enabled: false,
  });

  assert.deepEqual(result, { enabled: false, gitignore_ok: true });
  assert.equal(gitignoreReads, 0, "disable metu .gitignore net neskaitomas");
  assert.equal(gitignoreWrites, 0);
  assert.equal(logs[0], "WORKTREE POLICY: enabled=false gitignore=ok");

  const writtenConfigJson = JSON.parse(writtenConfig.text ?? "{}");
  assert.deepEqual(writtenConfigJson, {
    enabled: false,
    root: ".ag-worktrees",
    branchPrefix: "ag-task",
    pathPrefix: "task",
  });
});

test("setWorktreePolicyEnabled: konfigas rašomas per parserį, nauja eilutė gale", async () => {
  const { ports, writtenConfig } = makePorts();
  await setWorktreePolicyEnabled(ports, { runtimeRoot: RUNTIME_ROOT, projectRoot: PROJECT_ROOT, enabled: false });
  assert.ok(writtenConfig.text?.endsWith("}\n"), "failas baigiasi nauja eilute");
});

test("setWorktreePolicyEnabled: neteisingas JSON arba ne-objektas meta InvalidWorktreePolicyConfigError", async () => {
  const invalidJson = makePorts({ readConfigFile: async () => "{ nutrūkę" });
  await assert.rejects(
    () => setWorktreePolicyEnabled(invalidJson.ports, { runtimeRoot: RUNTIME_ROOT, projectRoot: PROJECT_ROOT, enabled: true }),
    (error: Error) => error instanceof InvalidWorktreePolicyConfigError && /not valid JSON/.test(error.message),
  );

  const arrayJson = makePorts({ readConfigFile: async () => "[]" });
  await assert.rejects(
    () => setWorktreePolicyEnabled(arrayJson.ports, { runtimeRoot: RUNTIME_ROOT, projectRoot: PROJECT_ROOT, enabled: true }),
    (error: Error) => error instanceof InvalidWorktreePolicyConfigError && /must be a JSON object/.test(error.message),
  );
});

test("setWorktreePolicyEnabled: tuščias .gitignore -> pridedama be pradinės tuščios eilutės", async () => {
  const { ports, writtenGitignore } = makePorts({ readGitignore: async () => undefined });
  await setWorktreePolicyEnabled(ports, { runtimeRoot: RUNTIME_ROOT, projectRoot: PROJECT_ROOT, enabled: true });
  assert.equal(
    writtenGitignore.text,
    "# VERQESTRA: worktree izoliacijos katalogas (auto-pridėta)\n.ag/worktrees/\n",
  );
});
