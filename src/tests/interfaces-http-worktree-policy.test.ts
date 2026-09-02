// Worktree politikos perjungimo modulis (AG 088): TIK `enabled` keičiasi JSON'e, o `.gitignore`
// liečiamas TIK įjungiant ir TIK jei worktree šaknis dar nepadengta.
//
// 112: „padengta" apibrėžia `git check-ignore` (portas `rootIsIgnored`), ne eilutės paieška.
// Todėl `gitignore_ok` čia tikrinamas kaip ELGESYS — jis privalo sekti porto atsakymą abiem
// kryptimis. Fake git yra `git.ignored` vėliavėlė: numatytasis `writeGitignore` ją įjungia (git
// pamato ką tik pridėtą eilutę), o testai, kuriems reikia „git vis tiek nemato", ją palieka.

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

type PortsWorld = {
  ports: WorktreePolicyPorts;
  writtenConfig: { text?: string };
  writtenGitignore: { text?: string };
  logs: string[];
  /** Fake git: ką atsakys `check-ignore`. */
  git: { ignored: boolean; asked: string[] };
};

function makePorts(
  overrides: Partial<WorktreePolicyPorts> = {},
  options: { ignored?: boolean; gitSeesAppend?: boolean } = {},
): PortsWorld {
  const writtenConfig: { text?: string } = {};
  const writtenGitignore: { text?: string } = {};
  const logs: string[] = [];
  const git = { ignored: options.ignored ?? false, asked: [] as string[] };
  const ports: WorktreePolicyPorts = {
    readConfigFile: async () => baseConfig(),
    writeConfigFile: async (_file, content) => {
      writtenConfig.text = content;
    },
    readGitignore: async () => undefined,
    writeGitignore: async (_file, content) => {
      writtenGitignore.text = content;
      // Realus git pamato ką tik įrašytą teisingą eilutę; `gitSeesAppend: false` modeliuoja medį,
      // kuriame jis jos nemato (ne git repozitorija).
      if (options.gitSeesAppend !== false) git.ignored = true;
    },
    rootIsIgnored: async (projectRoot) => {
      git.asked.push(projectRoot);
      return git.ignored;
    },
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { ports, writtenConfig, writtenGitignore, logs, git };
}

test("setWorktreePolicyEnabled: enable be eilutės -> eilutė pridėta ir log gitignore=appended", async () => {
  const { ports, writtenConfig, writtenGitignore, logs, git } = makePorts({
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
  assert.equal(logs[0], "WORKTREE POLICY: enabled=true gitignore=appended ignored=true");
  // Po rašymo patikra KARTOJAMA: atsakymas apie ką tik pakeistą failą negali remtis sena reikšme.
  assert.deepEqual(git.asked, [PROJECT_ROOT, PROJECT_ROOT]);

  const writtenConfigJson = JSON.parse(writtenConfig.text ?? "{}");
  assert.equal(writtenConfigJson.enabled, true);
  assert.equal(writtenConfigJson.root, ".ag-worktrees", "kiti laukai išsaugomi");
});

test("setWorktreePolicyEnabled: enable kai git jau ignoruoja -> .gitignore net neskaitomas", async () => {
  let gitignoreReads = 0;
  let gitignoreWrites = 0;
  const { ports, logs } = makePorts(
    {
      readGitignore: async () => {
        gitignoreReads += 1;
        return "dist/\n\n.ag/worktrees/\n";
      },
      writeGitignore: async () => {
        gitignoreWrites += 1;
      },
    },
    { ignored: true },
  );

  const result = await setWorktreePolicyEnabled(ports, {
    runtimeRoot: RUNTIME_ROOT,
    projectRoot: PROJECT_ROOT,
    enabled: true,
  });

  assert.deepEqual(result, { enabled: true, gitignore_ok: true });
  assert.equal(gitignoreWrites, 0, ".gitignore neturi būti rašomas, kai šaknis jau ignoruojama");
  assert.equal(gitignoreReads, 0, "check-ignore atsakė 'taip' — failo skaityti nebėra ko");
  assert.equal(logs[0], "WORKTREE POLICY: enabled=true gitignore=ok ignored=true");
});

// 112 REGRESIJA: ` .ag/worktrees/` su priekiniu tarpu git'ui yra KITAS šablonas. Trim-lygintuvas
// tokį failą laikė padengtu, tad eilutė nebūdavo pridėta, o atsakymas vis tiek sakydavo „ok".
test("setWorktreePolicyEnabled: eilutė su priekiniu tarpu nėra padengimas -> pridedama pažodinė", async () => {
  const { ports, writtenGitignore, logs } = makePorts({
    readGitignore: async () => "node_modules/\n .ag/worktrees/\n",
  });

  const result = await setWorktreePolicyEnabled(ports, {
    runtimeRoot: RUNTIME_ROOT,
    projectRoot: PROJECT_ROOT,
    enabled: true,
  });

  assert.deepEqual(result, { enabled: true, gitignore_ok: true });
  assert.match(writtenGitignore.text ?? "", /\n\.ag\/worktrees\/\n$/, "pridėta eilutė be tarpo");
  assert.ok(writtenGitignore.text?.includes(" .ag/worktrees/\n"), "esama eilutė nekeičiama");
  assert.equal(logs[0], "WORKTREE POLICY: enabled=true gitignore=appended ignored=true");
});

test("setWorktreePolicyEnabled: pažodinė eilutė yra, bet git jos nemato -> gitignore_ok=false be antros eilutės", async () => {
  let gitignoreWrites = 0;
  const { ports, logs } = makePorts({
    readGitignore: async () => "node_modules/\n.ag/worktrees/\n",
    writeGitignore: async () => {
      gitignoreWrites += 1;
    },
  });

  const result = await setWorktreePolicyEnabled(ports, {
    runtimeRoot: RUNTIME_ROOT,
    projectRoot: PROJECT_ROOT,
    enabled: true,
  });

  // Atsakymas seka check-ignore, ne failo turinį.
  assert.deepEqual(result, { enabled: true, gitignore_ok: false });
  assert.equal(gitignoreWrites, 0, "tos pačios eilutės dublikatas nieko neišspręstų");
  assert.equal(logs[0], "WORKTREE POLICY: enabled=true gitignore=literal-line-present ignored=false");
});

test("setWorktreePolicyEnabled: ne git medyje eilutė pridedama, bet gitignore_ok lieka sąžiningas false", async () => {
  const { ports, writtenGitignore, logs } = makePorts({}, { gitSeesAppend: false });

  const result = await setWorktreePolicyEnabled(ports, {
    runtimeRoot: RUNTIME_ROOT,
    projectRoot: PROJECT_ROOT,
    enabled: true,
  });

  assert.deepEqual(result, { enabled: true, gitignore_ok: false });
  assert.ok(writtenGitignore.text?.endsWith(".ag/worktrees/\n"), "eilutė vis tiek įrašoma");
  assert.equal(logs[0], "WORKTREE POLICY: enabled=true gitignore=appended ignored=false");
});

test("setWorktreePolicyEnabled: disable -> keičiasi tik enabled, .gitignore niekada neliečiamas", async () => {
  let gitignoreReads = 0;
  let gitignoreWrites = 0;
  const { ports, writtenConfig, logs } = makePorts(
    {
      readConfigFile: async () => baseConfig({ enabled: true, pathPrefix: "task" }),
      readGitignore: async () => {
        gitignoreReads += 1;
        return undefined;
      },
      writeGitignore: async () => {
        gitignoreWrites += 1;
      },
    },
    { ignored: true },
  );

  const result = await setWorktreePolicyEnabled(ports, {
    runtimeRoot: RUNTIME_ROOT,
    projectRoot: PROJECT_ROOT,
    enabled: false,
  });

  assert.deepEqual(result, { enabled: false, gitignore_ok: true });
  assert.equal(gitignoreReads, 0, "disable metu .gitignore net neskaitomas");
  assert.equal(gitignoreWrites, 0);
  assert.equal(logs[0], "WORKTREE POLICY: enabled=false gitignore=untouched ignored=true");

  const writtenConfigJson = JSON.parse(writtenConfig.text ?? "{}");
  assert.deepEqual(writtenConfigJson, {
    enabled: false,
    root: ".ag-worktrees",
    branchPrefix: "ag-task",
    pathPrefix: "task",
  });
});

test("setWorktreePolicyEnabled: disable nepadengtame medyje grąžina false, o ne literalą true", async () => {
  const { ports, logs } = makePorts({}, { ignored: false });

  const result = await setWorktreePolicyEnabled(ports, {
    runtimeRoot: RUNTIME_ROOT,
    projectRoot: PROJECT_ROOT,
    enabled: false,
  });

  assert.deepEqual(result, { enabled: false, gitignore_ok: false });
  assert.equal(logs[0], "WORKTREE POLICY: enabled=false gitignore=untouched ignored=false");
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
