// VQ-504 (52/N) testai — kopijos runtime bootstrap'as.
//
// Du sluoksniai: GRYNI workspace šablonų parseriai (visos kraštinės formos be failų sistemos) ir
// pats bootstrap'as ant tikro katalogo. Svarbiausias jo invariantas — `dist` kopija gauna ŠVIEŽIĄ
// `.buildstamp` mtime: be jo vaiko šviežumo vartas kiekvieną veiksmą matytų kaip stale.

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  discoverProductRoots,
  globSegmentMatcher,
  parseManifestWorkspacePatterns,
  parsePnpmWorkspacePatterns,
} from "../infrastructure/git/worktrees/workspace-roots.js";
import {
  ensureWorktreeRuntime,
  type ProductInstallRequest,
  type WorktreeRuntimeLayout,
} from "../infrastructure/git/worktrees/worktree-runtime.js";

const LAYOUT: WorktreeRuntimeLayout = {
  distDir: "dist",
  nodeModulesDir: "node_modules",
  configFiles: ["vq/config/local.env"],
  optionalJunctions: ["ui-app/dist"],
};

test("pnpm workspace sąrašas: komentarai, kabutės ir sąrašo pabaiga", () => {
  const patterns = parsePnpmWorkspacePatterns(
    ["packages:", "  - 'packages/*'   # komentaras", '  - "apps/**"', "  - AG/mobile-app", "onlyBuiltDependencies:", "  - esbuild"].join(
      "\n",
    ),
  );
  // Naujas top-level raktas nutraukia sąrašą — kitaip į šablonus patektų svetima sekcija.
  assert.deepEqual(patterns, ["packages/*", "apps/**", "AG/mobile-app"]);
});

test("manifest workspaces abiem formomis; sugadintas JSON nėra klaida", () => {
  assert.deepEqual(parseManifestWorkspacePatterns('{"workspaces":["a","b"]}'), ["a", "b"]);
  assert.deepEqual(parseManifestWorkspacePatterns('{"workspaces":{"packages":["c"]}}'), ["c"]);
  assert.deepEqual(parseManifestWorkspacePatterns("{ne json"), [], "sugadintas manifest'as = workspace'ų nežinome");
  assert.deepEqual(parseManifestWorkspacePatterns('{"workspaces":[1,"d"]}'), ["d"]);
});

test("globas dengia tik VIENĄ segmentą, o taškas nėra „bet kas“", () => {
  assert.equal(globSegmentMatcher("ui-*").test("ui-app"), true);
  assert.equal(globSegmentMatcher("ui-*").test("api"), false);
  assert.equal(globSegmentMatcher("*").test("a/b"), false, "vieno segmento globas skyriklio nekerta");
  assert.equal(globSegmentMatcher("a.b").test("axb"), false, "taškas escape'inamas");
});

test("šaknis visada kandidatė, o praleistos šaknys išmetamos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-504-roots-"));
  try {
    await writeFile(path.join(root, "package.json"), '{"workspaces":["packages/*"]}', "utf8");
    await mkdir(path.join(root, "packages", "alpha"), { recursive: true });
    await writeFile(path.join(root, "packages", "alpha", "package.json"), "{}", "utf8");
    await mkdir(path.join(root, "packages", "be-manifesto"), { recursive: true });

    const roots = await discoverProductRoots({
      treeAbs: root,
      readFileIfExists: async (target) => {
        try {
          return await readFile(target, "utf8");
        } catch {
          return undefined;
        }
      },
      pathExists: async (target) => {
        try {
          await lstat(target);
          return true;
        } catch {
          return false;
        }
      },
    });

    // Katalogas be `package.json` nėra paketo šaknis, net kai šabloną atitinka.
    assert.deepEqual(roots, [".", "packages/alpha"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function primaryTree(): Promise<{ root: string; worktree: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-504-wt-"));
  const primary = path.join(root, "primary");
  const worktree = path.join(root, "copy");
  await mkdir(path.join(primary, "dist"), { recursive: true });
  await writeFile(path.join(primary, "dist", "cli.js"), "// cli\n", "utf8");
  await writeFile(path.join(primary, "dist", ".buildstamp"), "stamp\n", "utf8");
  await mkdir(path.join(primary, "node_modules"), { recursive: true });
  await mkdir(path.join(primary, "vq", "config"), { recursive: true });
  await writeFile(path.join(primary, "vq", "config", "local.env"), "MODEL=x\n", "utf8");
  await mkdir(worktree, { recursive: true });
  return { root: primary, worktree };
}

test("dist KOPIJUOJAMAS, o jo `.buildstamp` gauna šviežią mtime", async () => {
  const { root, worktree } = await primaryTree();
  const parent = path.dirname(root);
  try {
    // Šaltinio stamp'as sąmoningai pasendinamas — būtent tai daro `cp` Windows'e.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const { utimes } = await import("node:fs/promises");
    await utimes(path.join(root, "dist", ".buildstamp"), old, old);

    await ensureWorktreeRuntime({ projectRoot: root, worktreeAbs: worktree, layout: LAYOUT });

    assert.equal((await readFile(path.join(worktree, "dist", "cli.js"), "utf8")).trim(), "// cli");
    const stamp = await stat(path.join(worktree, "dist", ".buildstamp"));
    // Be atnaujinimo kopijuotas stamp'as būtų senesnis už kopijos `src`, ir šviežumo vartas
    // vaiko hook'uose blokuotų kiekvieną veiksmą.
    assert.ok(Date.now() - stamp.mtimeMs < 60_000);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("trūkstamas pirminis dist yra FAIL-CLOSED klaida", async () => {
  const { root, worktree } = await primaryTree();
  const parent = path.dirname(root);
  try {
    await rm(path.join(root, "dist"), { recursive: true, force: true });
    await assert.rejects(
      () => ensureWorktreeRuntime({ projectRoot: root, worktreeAbs: worktree, layout: LAYOUT }),
      /nerastas/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("dist be šaltinio `.buildstamp` NELŪŽTA — žyma sukuriama kopijoje", async () => {
  const { root, worktree } = await primaryTree();
  const parent = path.dirname(root);
  try {
    // GeoGravity 2026-08-29: 21/44 w2 slot'ų žuvo TIK dėl trūkstamos žymos, nors pats dist
    // pilnas — bootstrap'as neturi lūžti dėl žymos nebuvimo, o sukurti ją kopijoje.
    await rm(path.join(root, "dist", ".buildstamp"), { force: true });
    await ensureWorktreeRuntime({ projectRoot: root, worktreeAbs: worktree, layout: LAYOUT });

    const stamp = await stat(path.join(worktree, "dist", ".buildstamp"));
    assert.ok(Date.now() - stamp.mtimeMs < 60_000, "sukurta žyma yra šviežia");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("konfigas kopijuojamas, o nesantis optional junction'as tik LOG'inamas", async () => {
  const { root, worktree } = await primaryTree();
  const parent = path.dirname(root);
  const logs: string[] = [];
  try {
    await ensureWorktreeRuntime({
      projectRoot: root,
      worktreeAbs: worktree,
      layout: LAYOUT,
      log: (message) => {
        logs.push(message);
        return Promise.resolve();
      },
    });

    assert.equal(await readFile(path.join(worktree, "vq", "config", "local.env"), "utf8"), "MODEL=x\n");
    // Nebuvimas nėra bootstrap'o klaida: patikra kopijoje kris sąžiningai dėl trūkstamo artefakto.
    assert.ok(logs.some((line) => line.includes("ui-app/dist") && line.includes("junction praleistas")));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("configDirs kopijuoja VISĄ konfigų katalogą, ne po failą", async () => {
  const { root, worktree } = await primaryTree();
  const parent = path.dirname(root);
  try {
    // GeoGravity 2026-08-28: vaikas be `tool-budget.json` lūžo iškart po delegavimo, nes
    // bootstrap'as kopijavo tik `local.env`. Katalogo kopija dengia ir dar neegzistuojančius
    // ateities konfigus be atskiro sąrašo priežiūros.
    await writeFile(path.join(root, "vq", "config", "tool-budget.json"), '{"limit":1}', "utf8");
    await mkdir(path.join(root, "vq", "config", "policy"), { recursive: true });
    await writeFile(path.join(root, "vq", "config", "policy", "nested.json"), "{}", "utf8");

    await ensureWorktreeRuntime({
      projectRoot: root,
      worktreeAbs: worktree,
      layout: { ...LAYOUT, configDirs: ["vq/config"] },
    });

    assert.equal(await readFile(path.join(worktree, "vq", "config", "tool-budget.json"), "utf8"), '{"limit":1}');
    assert.equal(await readFile(path.join(worktree, "vq", "config", "policy", "nested.json"), "utf8"), "{}");
    assert.equal(await readFile(path.join(worktree, "vq", "config", "local.env"), "utf8"), "MODEL=x\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("pakartotinis kvietimas nieko negriauna", async () => {
  const { root, worktree } = await primaryTree();
  const parent = path.dirname(root);
  try {
    await ensureWorktreeRuntime({ projectRoot: root, worktreeAbs: worktree, layout: LAYOUT });
    // Vaiko nuosavas dist po perbuildinimo — pakartotinis bootstrap'as jo NEPERRAŠO.
    await writeFile(path.join(worktree, "dist", "cli.js"), "// vaiko build\n", "utf8");
    await ensureWorktreeRuntime({ projectRoot: root, worktreeAbs: worktree, layout: LAYOUT });

    assert.equal((await readFile(path.join(worktree, "dist", "cli.js"), "utf8")).trim(), "// vaiko build");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("be žinomo lockfile produkto deps žingsnis PRALEIDŽIAMAS", async () => {
  const { root, worktree } = await primaryTree();
  const parent = path.dirname(root);
  const logs: string[] = [];
  let installs = 0;
  try {
    await ensureWorktreeRuntime({
      projectRoot: root,
      worktreeAbs: worktree,
      layout: LAYOUT,
      log: (message) => {
        logs.push(message);
        return Promise.resolve();
      },
      runProductInstall: () => {
        installs += 1;
        return Promise.resolve(0);
      },
    });

    assert.equal(installs, 0);
    assert.ok(logs.some((line) => line.includes("nėra žinomo lockfile")));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("sutampantys lockfile hash'ai duoda junction'us, ne install'ą", async () => {
  const { root, worktree } = await primaryTree();
  const parent = path.dirname(root);
  const logs: string[] = [];
  let installs = 0;
  try {
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    await writeFile(path.join(root, "package.json"), "{}", "utf8");
    await writeFile(path.join(worktree, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    await writeFile(path.join(worktree, "package.json"), "{}", "utf8");

    await ensureWorktreeRuntime({
      projectRoot: root,
      worktreeAbs: worktree,
      layout: LAYOUT,
      log: (message) => {
        logs.push(message);
        return Promise.resolve();
      },
      runProductInstall: () => {
        installs += 1;
        return Promise.resolve(0);
      },
    });

    // Šaknies `node_modules` jau sujunction'intas runtime žingsnyje — antro darbo nėra.
    assert.equal(installs, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

/** Paruošia lockfile pakeitimą kopijoje — junction'as meluotų, tad install'as privalo suktis. */
async function primaryTreeWithChangedLockfile(): Promise<{ root: string; worktree: string }> {
  const { root, worktree } = await primaryTree();
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
  await writeFile(path.join(root, "package.json"), '{"workspaces":["packages/*"]}', "utf8");
  await writeFile(path.join(worktree, "pnpm-lock.yaml"), "lockfileVersion: 9\n# kitas\n", "utf8");
  await writeFile(path.join(worktree, "package.json"), '{"workspaces":["packages/*"]}', "utf8");
  await mkdir(path.join(worktree, "packages", "alpha"), { recursive: true });
  await writeFile(path.join(worktree, "packages", "alpha", "package.json"), "{}", "utf8");
  return { root, worktree };
}

/**
 * `npm_execpath` yra ambient — priklauso nuo to, KUO paleistas testų procesas. Kad testai
 * liktų deterministiniai nepaisant aplinkos, kiekvienas iš trijų žemiau esančių ją eksplicitiškai
 * nustato ir grąžina originalią reikšmę `finally` bloke.
 */
function withNpmExecpath<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const original = process.env["npm_execpath"];
  if (value === undefined) delete process.env["npm_execpath"];
  else process.env["npm_execpath"] = value;
  return run().finally(() => {
    if (original === undefined) delete process.env["npm_execpath"];
    else process.env["npm_execpath"] = original;
  });
}

test("pasikeitęs lockfile paleidžia install'ą, o jo nesėkmė STABDO", async () => {
  const { root, worktree } = await primaryTreeWithChangedLockfile();
  const parent = path.dirname(root);
  const requests: ProductInstallRequest[] = [];
  try {
    // Be `npm_execpath` žymos elgesys lieka toks pat kaip iki GeoGravity taisymo — plika komanda.
    await withNpmExecpath(undefined, () =>
      assert.rejects(
        () =>
          ensureWorktreeRuntime({
            projectRoot: root,
            worktreeAbs: worktree,
            layout: LAYOUT,
            runProductInstall: (request) => {
              requests.push(request);
              return Promise.resolve(1);
            },
          }),
        /exit 1/,
      ),
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.cwd, worktree, "install'as VISADA kopijoje, ne pirminiame medyje");
    assert.equal(requests[0]?.command, "pnpm", "be npm_execpath — plika komanda kaip anksčiau");
    assert.deepEqual(requests[0]?.args, ["install", "--frozen-lockfile"], "lockfile-neutrali komanda");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("npm_execpath nurodo neegzistuojantį pnpm kelią — aiški klaida vietoj plikos 127", async () => {
  const { root, worktree } = await primaryTreeWithChangedLockfile();
  const parent = path.dirname(root);
  const missingExecpath = path.join(root, "..", "no-such-pnpm", "pnpm.cjs");
  try {
    await withNpmExecpath(missingExecpath, () =>
      assert.rejects(
        () =>
          ensureWorktreeRuntime({
            projectRoot: root,
            worktreeAbs: worktree,
            layout: LAYOUT,
            runProductInstall: () => Promise.resolve(0),
          }),
        new RegExp(`pnpm nerastas: ${missingExecpath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      ),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("npm_execpath rodo į esamą pnpm skriptą — install'as kviečiamas per node interpretatorių", async () => {
  const { root, worktree } = await primaryTreeWithChangedLockfile();
  const parent = path.dirname(root);
  const execpath = path.join(root, "..", "pnpm-shim", "pnpm.cjs");
  const requests: ProductInstallRequest[] = [];
  try {
    await mkdir(path.dirname(execpath), { recursive: true });
    await writeFile(execpath, "// pnpm shim\n", "utf8");

    await withNpmExecpath(execpath, () =>
      ensureWorktreeRuntime({
        projectRoot: root,
        worktreeAbs: worktree,
        layout: LAYOUT,
        runProductInstall: (request) => {
          requests.push(request);
          return Promise.resolve(0);
        },
      }),
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.command, process.execPath, "skriptas paleidžiamas per node, ne tiesiogiai");
    assert.deepEqual(
      requests[0]?.args,
      [execpath, "install", "--frozen-lockfile"],
      "sėkmingas kelias — komanda absoliuti, argumentai nepakitę",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
