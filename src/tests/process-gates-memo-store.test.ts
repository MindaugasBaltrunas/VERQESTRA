// VQ-504 (63/N) testai — kokybės vartų memo saugykla.
//
// Memo klaida yra TYLUS vartų praleidimas, tad tikrinama būtent tapatybės disciplina: ne git
// medyje tapatybės nėra (`null` → suite bėga), o pasikeitęs `dist` ar politika duoda KITĄ raktą
// prie to paties medžio.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createGatesMemoPort } from "../infrastructure/process/gates-memo-store.js";
import { run } from "../infrastructure/process/run-process.js";

type World = { projectRoot: string; runtimeRoot: string; distDir: string };

async function workspace(options: { git?: boolean } = {}): Promise<World> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-504-memo-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  const distDir = path.join(projectRoot, "dist");
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "config"), { recursive: true });
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, "cli.js"), "// v1\n", "utf8");
  await writeFile(path.join(projectRoot, "src.ts"), "export const a = 1;\n", "utf8");

  if (options.git === true) {
    await run("git", ["init"], { cwd: projectRoot, timeoutMs: 60_000 });
    await run("git", ["config", "user.email", "test@example.com"], { cwd: projectRoot, timeoutMs: 30_000 });
    await run("git", ["config", "user.name", "Test"], { cwd: projectRoot, timeoutMs: 30_000 });
  }
  return { projectRoot, runtimeRoot, distDir };
}

const identityInput = { scope: "all", commands: ["pnpm test"] };

test("ne git medyje tapatybės NĖRA — suite bėga", async () => {
  const world = await workspace();
  try {
    const identity = await createGatesMemoPort(world).identify({ projectRoot: world.projectRoot, ...identityInput });
    // `null` reiškia „nežinome", ir nežinia niekada nevirsta praleidimu.
    assert.equal(identity, null);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("tas pats medis duoda TĄ PATĮ raktą, pakeistas — kitą", async () => {
  const world = await workspace({ git: true });
  try {
    const port = createGatesMemoPort(world);
    const first = await port.identify({ projectRoot: world.projectRoot, ...identityInput });
    assert.notEqual(first, null);

    const same = await port.identify({ projectRoot: world.projectRoot, ...identityInput });
    assert.equal(same?.key, first?.key);

    await writeFile(path.join(world.projectRoot, "src.ts"), "export const a = 2;\n", "utf8");
    const changed = await port.identify({ projectRoot: world.projectRoot, ...identityInput });
    assert.notEqual(changed?.key, first?.key);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("pasikeitęs `dist` prie to paties `src` yra KITAS paleidimas", async () => {
  const world = await workspace({ git: true });
  try {
    const port = createGatesMemoPort(world);
    const first = await port.identify({ projectRoot: world.projectRoot, ...identityInput });

    // `dist` yra gitignore'inamas realiame repo, tad medžio hash'as jo nemato — todėl jis
    // skaičiuojamas ATSKIRAI: vartai vykdo būtent build'intą kodą.
    await writeFile(path.join(world.distDir, "cli.js"), "// v2\n", "utf8");
    const changed = await port.identify({ projectRoot: world.projectRoot, ...identityInput });

    assert.notEqual(changed?.dist, first?.dist);
    assert.notEqual(changed?.key, first?.key);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("pakeista vartų politika irgi keičia raktą", async () => {
  const world = await workspace({ git: true });
  try {
    const port = createGatesMemoPort(world);
    const first = await port.identify({ projectRoot: world.projectRoot, ...identityInput });

    await writeFile(path.join(world.runtimeRoot, "config", "quality-policy.json"), '{"checks":[]}', "utf8");
    const changed = await port.identify({ projectRoot: world.projectRoot, ...identityInput });

    // Pakeitus komandas, senas žalias verdiktas nieko nebesako.
    assert.notEqual(changed?.config, first?.config);
    assert.notEqual(changed?.key, first?.key);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("task failo perkėlimas AG/tasks viduje NEkeičia tapatybės", async () => {
  const world = await workspace({ git: true });
  try {
    await mkdir(path.join(world.projectRoot, "AG", "tasks", "active"), { recursive: true });
    await mkdir(path.join(world.projectRoot, "AG", "tasks", "queue"), { recursive: true });
    await writeFile(path.join(world.projectRoot, "AG", "tasks", "active", "044-x.md"), "# task\n", "utf8");

    const port = createGatesMemoPort(world);
    const first = await port.identify({ projectRoot: world.projectRoot, ...identityInput });
    assert.notEqual(first, null);

    await rm(path.join(world.projectRoot, "AG", "tasks", "active", "044-x.md"));
    await writeFile(path.join(world.projectRoot, "AG", "tasks", "queue", "044-x.md"), "# task\n", "utf8");
    const afterMove = await port.identify({ projectRoot: world.projectRoot, ...identityInput });

    assert.equal(afterMove?.tree, first?.tree);
    assert.equal(afterMove?.key, first?.key);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("AG/state ir AG/logs pokyčiai NEkeičia tapatybės, o `src` failo pakeitimas keičia", async () => {
  const world = await workspace({ git: true });
  try {
    await mkdir(path.join(world.projectRoot, "AG", "state"), { recursive: true });
    await mkdir(path.join(world.projectRoot, "AG", "logs"), { recursive: true });
    await writeFile(path.join(world.projectRoot, "AG", "state", "ledger.json"), "{}", "utf8");
    await writeFile(path.join(world.projectRoot, "AG", "logs", "session.md"), "log v1\n", "utf8");

    const port = createGatesMemoPort(world);
    const first = await port.identify({ projectRoot: world.projectRoot, ...identityInput });
    assert.notEqual(first, null);

    await writeFile(path.join(world.projectRoot, "AG", "state", "ledger.json"), '{"n":1}', "utf8");
    await writeFile(path.join(world.projectRoot, "AG", "logs", "session.md"), "log v2\n", "utf8");
    const afterLifecycleChange = await port.identify({ projectRoot: world.projectRoot, ...identityInput });
    assert.equal(afterLifecycleChange?.tree, first?.tree);
    assert.equal(afterLifecycleChange?.key, first?.key);

    await writeFile(path.join(world.projectRoot, "src.ts"), "export const a = 2;\n", "utf8");
    const afterSrcChange = await port.identify({ projectRoot: world.projectRoot, ...identityInput });
    assert.notEqual(afterSrcChange?.tree, first?.tree);
    assert.notEqual(afterSrcChange?.key, first?.key);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("naujas untracked failas `src` viduje keičia tapatybę", async () => {
  const world = await workspace({ git: true });
  try {
    const port = createGatesMemoPort(world);
    const first = await port.identify({ projectRoot: world.projectRoot, ...identityInput });
    assert.notEqual(first, null);

    await writeFile(path.join(world.projectRoot, "src-new.ts"), "export const b = 1;\n", "utf8");
    const changed = await port.identify({ projectRoot: world.projectRoot, ...identityInput });

    assert.notEqual(changed?.tree, first?.tree);
    assert.notEqual(changed?.key, first?.key);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("kitas scope duoda kitą raktą", async () => {
  const world = await workspace({ git: true });
  try {
    const port = createGatesMemoPort(world);
    const all = await port.identify({ projectRoot: world.projectRoot, scope: "all", commands: ["pnpm test"] });
    const fast = await port.identify({ projectRoot: world.projectRoot, scope: "fast", commands: ["pnpm test"] });
    assert.notEqual(all?.key, fast?.key);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("įrašas: `absent` → `write` → `hit` → `clear`", async () => {
  const world = await workspace();
  try {
    const port = createGatesMemoPort(world);
    assert.equal((await port.read(world.projectRoot)).status, "absent");

    await port.write(world.projectRoot, {
      schema_version: 1,
      key: "k1",
      tree: "t1",
      dist: "d1",
      config: "c1",
      scope: "all",
      commands: ["pnpm test"],
      passed_at: "2026-08-21T12:00:00.000Z",
    });
    assert.equal((await port.read(world.projectRoot)).status, "hit");

    await port.clear(world.projectRoot);
    assert.equal((await port.read(world.projectRoot)).status, "absent");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("sugadintas įrašas yra `corrupted`, NE `absent`", async () => {
  const world = await workspace();
  try {
    await writeFile(path.join(world.runtimeRoot, "state", "quality-gates-memo.json"), "{ne json", "utf8");
    const result = await createGatesMemoPort(world).read(world.projectRoot);
    // Sugadintas antspaudas reiškia pilną suite, o ne tylų praėjimą.
    assert.equal(result.status, "corrupted");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});
