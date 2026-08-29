// Worktree `.gitignore` dengimo porto (`WavesViewPorts.readWorktreeGitignoreOk`) surišimas su
// tikru fs (088-b-03). Vertimo logika (kada laukas rodomas/praleidžiamas/degraduoja) jau padengta
// `interfaces-http-waves-view.test.ts` su pin'intais mock portais — čia tikrinamas TIK adapteris:
// ar jis realiai skaito PROJEKTO `.gitignore` ir teisingai atpažįsta worktree eilutę.
//
// Antra dalis (088-bb-03) — RAŠYMO pusė: `UiRouterPorts.worktreePolicy` surišimas su tikrais fs
// adapteriais. Perjungimo logika (kas keičiasi konfige, kada liečiamas `.gitignore`) pin'inta
// `interfaces-http-worktree-policy.test.ts` mock portais; čia tikrinama, kad per REALŲ diską
// atsiranda būtent tie failai ir tik jie. Visi keliai — laikinajame kataloge: šio repo šakninis
// `.gitignore` ir `vq/config/` testo metu neliečiami nė skaitymui.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { uiRouterPorts } from "../composition/ui/router-adapters.js";
import { setWorktreePolicyEnabled } from "../interfaces/http/ui-worktree-policy.js";

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

const WORKTREE_LINE = ".ag/worktrees/";

/** Konfigas su papildomais laukais: perjungimas privalo perkelti juos nepaliestus. */
async function writePolicyConfig(sandbox: Sandbox, enabled: boolean): Promise<void> {
  const configDir = path.join(sandbox.runtimeRoot, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "worktree-policy.json"),
    `${JSON.stringify({ enabled, root: ".ag/worktrees", branchPrefix: "ag/" }, null, 2)}\n`,
    "utf8",
  );
}

async function readPolicyConfig(sandbox: Sandbox): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(sandbox.runtimeRoot, "config", "worktree-policy.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readGitignoreOrUndefined(sandbox: Sandbox): Promise<string | undefined> {
  return await readFile(path.join(sandbox.projectRoot, ".gitignore"), "utf8").catch(() => undefined);
}

function countWorktreeLines(content: string): number {
  return content.split(/\r?\n/).filter((line) => line.trim() === WORKTREE_LINE).length;
}

/** Perjungimas per SURIŠTUS composition portus — būtent tai, ką maršrutas gauna produkcijoje. */
async function toggle(
  sandbox: Sandbox,
  enabled: boolean,
  logs: string[],
): Promise<{ enabled: boolean; gitignore_ok: boolean }> {
  const ports = uiRouterPorts({ ...sandbox, logError: (message) => logs.push(message) });
  assert.ok(ports.worktreePolicy, "worktreePolicy portas privalo būti surištas (kitaip maršrutas yra 404)");
  return await setWorktreePolicyEnabled(ports.worktreePolicy, {
    runtimeRoot: sandbox.runtimeRoot,
    projectRoot: sandbox.projectRoot,
    enabled,
  });
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

test("worktreePolicy surišimas: enabled=true įrašo konfigą ir sukuria .gitignore eilutę", async () => {
  const sandbox = await makeSandbox();
  const logs: string[] = [];
  try {
    await writePolicyConfig(sandbox, false);

    const result = await toggle(sandbox, true, logs);

    assert.deepEqual(result, { enabled: true, gitignore_ok: true });
    // Kiti laukai NEPALIESTI: perjungimas keičia lygiai vieną raktą.
    assert.deepEqual(await readPolicyConfig(sandbox), {
      enabled: true,
      root: ".ag/worktrees",
      branchPrefix: "ag/",
    });
    const gitignore = await readGitignoreOrUndefined(sandbox);
    assert.ok(gitignore !== undefined, "nesamas .gitignore įjungiant sukuriamas");
    assert.equal(countWorktreeLines(gitignore), 1);
    assert.ok(logs.some((line) => line.includes("enabled=true")), "perjungimas palieka žurnalo eilutę");

    // Skaitymo pusė mato TĄ PATĮ diską, kurį ką tik parašė rašymo pusė.
    assert.equal(await readGitignoreOkField(sandbox), true);
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("worktreePolicy surišimas: pakartotinis enabled=true nedubliuoja .gitignore eilutės", async () => {
  const sandbox = await makeSandbox();
  const logs: string[] = [];
  try {
    await writePolicyConfig(sandbox, false);
    await writeFile(path.join(sandbox.projectRoot, ".gitignore"), "node_modules/\n", "utf8");

    await toggle(sandbox, true, logs);
    const afterFirst = await readGitignoreOrUndefined(sandbox);
    await toggle(sandbox, true, logs);
    const afterSecond = await readGitignoreOrUndefined(sandbox);

    assert.ok(afterFirst !== undefined && afterSecond !== undefined);
    assert.equal(countWorktreeLines(afterSecond), 1, "antras tas pats perjungimas eilutės nekartoja");
    // Idempotentiška ne tik eilučių skaičiumi: failas byte-for-byte tas pats, o esamas
    // turinys išlieka pirmoje eilutėje.
    assert.equal(afterSecond, afterFirst);
    assert.ok(afterSecond.startsWith("node_modules/\n"), "esamas turinys nekeičiamas");
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("worktreePolicy surišimas: enabled=false rašo tik konfigą, .gitignore neliečia", async () => {
  const sandbox = await makeSandbox();
  const logs: string[] = [];
  try {
    await writePolicyConfig(sandbox, true);

    const result = await toggle(sandbox, false, logs);

    assert.deepEqual(result, { enabled: false, gitignore_ok: true });
    assert.equal((await readPolicyConfig(sandbox))["enabled"], false);
    // „Neliečia" reiškia NĖ VIENO efekto: nesantis failas lieka nesantis, o ne tuščias.
    assert.equal(await readGitignoreOrUndefined(sandbox), undefined);
    assert.ok(logs.some((line) => line.includes("enabled=false")), "išjungimas irgi žurnale");
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("worktreePolicy surišimas: nesamas konfigas KRENTA (maršrute virsta 500, ne tylia politika)", async () => {
  const sandbox = await makeSandbox();
  try {
    // Jokio `vq/config/worktree-policy.json`.
    await assert.rejects(() => toggle(sandbox, true, []));
    // Svarbiausia pasekmė: klaida iki `.gitignore` nedaeina.
    assert.equal(await readGitignoreOrUndefined(sandbox), undefined);
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});
