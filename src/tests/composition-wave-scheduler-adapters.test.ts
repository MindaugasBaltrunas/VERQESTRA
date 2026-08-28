// 054-a-02 testai — worktree politikos KELIAS bangos aprūpinimo adapteryje.
//
// Šis failas pinina vieną dalyką: `waveWorktreePort().policyEnabled()` skaito
// `runtimeRoot/config/worktree-policy.json`, o ne seną `AG/config/` vietą. Kelio regresija
// yra tylusis atvejis — politika lieka `false` (default), aprūpinimas atsisako slot'ų, ir
// niekas nemeta klaidos. Simptomas matomas tik gyvame diegime, tad be šio testo jis grįžtų.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { waveWorktreePort } from "../composition/loop/wave-scheduler-adapters.js";

let root = "";

/** Švarus projekto medis su tuščiu `vq` runtime — kiekvienas testas politiką deda pats. */
async function freshRoots(): Promise<{ projectRoot: string; runtimeRoot: string }> {
  const projectRoot = await mkdtemp(path.join(root, "case-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  await mkdir(runtimeRoot, { recursive: true });
  return { projectRoot, runtimeRoot };
}

async function writePolicy(dir: string, enabled: boolean): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "worktree-policy.json"), JSON.stringify({ enabled }), "utf8");
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vq-054-worktree-policy-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("politika iš `runtimeRoot/config/worktree-policy.json` ĮJUNGIA aprūpinimą", async () => {
  const roots = await freshRoots();
  await writePolicy(path.join(roots.runtimeRoot, "config"), true);

  assert.equal(await waveWorktreePort(roots).policyEnabled(), true);
});

test("to paties failo `enabled:false` politiką IŠJUNGIA", async () => {
  const roots = await freshRoots();
  await writePolicy(path.join(roots.runtimeRoot, "config"), false);

  // Kartu tai įrodo, kad `true` ankstesniame teste atėjo iš failo, o ne iš konstantos.
  assert.equal(await waveWorktreePort(roots).policyEnabled(), false);
});

test("be politikos failo grąžinamas default `false`", async () => {
  const roots = await freshRoots();

  // Nežinia NĖRA teigiamas atsakymas: be politikos aprūpinimas dirba mažiau, o ne klaidingai.
  assert.equal(await waveWorktreePort(roots).policyEnabled(), false);
});

test("failas SENOJE `AG/config/` vietoje politikos NEĮJUNGIA", async () => {
  const roots = await freshRoots();
  await writePolicy(path.join(roots.projectRoot, "AG", "config"), true);

  // Būtent šis atvejis ir buvo regresija: install'as rašo į `vq/config`, o skaitymas iš `AG/config`
  // paliktų politiką amžinai išjungtą — be jokios klaidos ir be jokio žurnalo įrašo.
  assert.equal(
    await waveWorktreePort(roots).policyEnabled(),
    false,
    "skaitymo kelias yra `runtimeRoot/config`, ne projekto `AG/config`",
  );
});
