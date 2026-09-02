// Task 101-b: `CONTROL_DOC_ROOTS` turinio tapatybė context cache raktui.
//
// Vienas invariantas, dėl kurio modulis egzistuoja: jei pasikeičia bet kas, kas patenka į
// discovered kandidatus, privalo pasikeisti ir grąžinamas šaltinių rinkinys. Priešingu atveju
// (101-c prijungus `docsSnippets`) cache HIT tyliai grąžintų pasenusį discovered tekstą.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DISCOVERED_DOCS_SOURCE_PREFIX,
  discoveredDocsCacheSources,
} from "../application/context-pack/discovered-docs-cache-sources.js";
import { computeContextCacheKey } from "../application/context-pack/context-cache-key.js";
import type { ContextCacheSource } from "../application/context-pack/context-cache-model.js";
import type { CodeIntelligenceFileSystemPort } from "../application/code-intelligence/ports.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";

async function withTempProject(build: (root: string) => Promise<void>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-discovered-cache-"));
  await build(root);
  return root;
}

async function sourcesFor(root: string): Promise<ContextCacheSource[]> {
  return await discoveredDocsCacheSources({ fs: nodeFsTestPort, projectRoot: root });
}

/**
 * Fake portas su valdoma `listDirectory` tvarka — ta pati konstrukcija kaip
 * `context-pack-discovered-docs.test.ts`, tik čia ji tikrina, kad šaltinių TVARKA
 * nepriklauso nuo traversal'o eiliškumo.
 */
function makeOrderedDocsPort(projectRoot: string, names: readonly string[]): CodeIntelligenceFileSystemPort {
  const docsDir = path.join(projectRoot, "docs");
  return {
    async listDirectory(absoluteDir) {
      return absoluteDir === docsDir ? names.map((name) => ({ name, isDirectory: false, isFile: true })) : [];
    },
    async statKind(absolutePath) {
      return absolutePath === docsDir ? "directory" : "absent";
    },
    async readTextFile(absolutePath) {
      return `# Antraštė\n\nturinys ${path.basename(absolutePath)}\n`;
    },
    async readFileBytes() {
      throw new Error("neturėtų būti kviečiama šiame teste");
    },
    async fileSize() {
      throw new Error("neturėtų būti kviečiama šiame teste");
    },
    async exists() {
      return true;
    },
    async writeTextFileAtomic() {
      throw new Error("neturėtų būti kviečiama šiame teste");
    },
    async makeDirectory() {
      throw new Error("neturėtų būti kviečiama šiame teste");
    },
  };
}

test("discoveredDocsCacheSources: tas pats medis duoda tą patį rinkinį", async () => {
  const root = await withTempProject(async (dir) => {
    await mkdir(path.join(dir, "docs", "nested"), { recursive: true });
    await writeFile(path.join(dir, "README.md"), "# Projektas\n\nĮvadas.\n\n## Ribos\n\nturinys.\n");
    await writeFile(path.join(dir, "docs", "guide.md"), "# Guide\n\nturinys.\n");
    await writeFile(path.join(dir, "docs", "nested", "deep.md"), "# Deep\n\ngilus turinys.\n");
  });
  try {
    assert.deepEqual(await sourcesFor(root), await sourcesFor(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoveredDocsCacheSources: po vieną šaltinį dokumentui, keliai su prefiksu ir be #anchor", async () => {
  const root = await withTempProject(async (dir) => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    // Trys antraštės viename dokumente — kandidatų trys, šaltinis vienas.
    await writeFile(path.join(dir, "docs", "a.md"), "# Pirma\n\nx.\n\n## Antra\n\ny.\n\n## Trečia\n\nz.\n");
    await writeFile(path.join(dir, "docs", "b.md"), "# B\n\nturinys b.\n");
  });
  try {
    const sources = await sourcesFor(root);
    assert.deepEqual(
      sources.map((source) => source.path),
      [`${DISCOVERED_DOCS_SOURCE_PREFIX}docs/a.md`, `${DISCOVERED_DOCS_SOURCE_PREFIX}docs/b.md`],
      "vienas šaltinis dokumentui, rūšiuota keliu, be antraštės anchor'o",
    );
    assert.ok(
      sources.every((source) => source.kind === "spec"),
      "discovered dokumentai atributuojami į `spec` komponentą",
    );
    assert.ok(
      sources.every((source) => /^[0-9a-f]{64}$/.test(source.hash)),
      "hash — sha256 hex, ta pati konvencija kaip kitiems šaltiniams",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoveredDocsCacheSources: pakeitus vieno dokumento turinį rinkinys skiriasi", async () => {
  const root = await withTempProject(async (dir) => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "README.md"), "# Projektas\n\nĮvadas.\n");
    await writeFile(path.join(dir, "docs", "guide.md"), "# Guide\n\npradinis turinys.\n");
  });
  try {
    const before = await sourcesFor(root);
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n\nPAKEISTAS turinys.\n");
    const after = await sourcesFor(root);

    assert.notDeepEqual(before, after, "turinio pakeitimas privalo pakeisti rinkinį");
    assert.deepEqual(
      before.map((source) => source.path),
      after.map((source) => source.path),
      "keliai nesikeičia — skiriasi tik pakeisto dokumento hash",
    );
    const changed = before.filter((source, index) => source.hash !== after[index]?.hash);
    assert.deepEqual(
      changed.map((source) => source.path),
      [`${DISCOVERED_DOCS_SOURCE_PREFIX}docs/guide.md`],
      "nepaliestas dokumentas savo hash'o nekeičia",
    );

    // Ir, svarbiausia, per raktą: dviejų medžių fingerprint'ai privalo išsiskirti.
    assert.notEqual(
      computeContextCacheKey(await discoveredDocsCacheSources({ fs: nodeFsTestPort, projectRoot: root })).fingerprint,
      computeContextCacheKey(before).fingerprint,
      "cache raktas mato discovered dokumentų turinio pokytį",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoveredDocsCacheSources: antraštės pervadinimas be turinio pakeitimo irgi keičia hash", async () => {
  const root = await withTempProject(async (dir) => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs", "a.md"), "# Sena antraštė\n\ntas pats turinys.\n");
  });
  try {
    const before = await sourcesFor(root);
    await writeFile(path.join(root, "docs", "a.md"), "# Nauja antraštė\n\ntas pats turinys.\n");
    const after = await sourcesFor(root);

    assert.notEqual(before[0]?.hash, after[0]?.hash, "`ref` yra kandidato tapatybės dalis, tad jis dalyvauja hash'e");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoveredDocsCacheSources: naujas dokumentas praplečia rinkinį, ištrintas — susiaurina", async () => {
  const root = await withTempProject(async (dir) => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs", "a.md"), "# A\n\nturinys.\n");
  });
  try {
    const before = await sourcesFor(root);
    await writeFile(path.join(root, "docs", "b.md"), "# B\n\nturinys.\n");
    const after = await sourcesFor(root);

    assert.equal(before.length, 1);
    assert.deepEqual(
      after.map((source) => source.path),
      [`${DISCOVERED_DOCS_SOURCE_PREFIX}docs/a.md`, `${DISCOVERED_DOCS_SOURCE_PREFIX}docs/b.md`],
    );

    await rm(path.join(root, "docs", "b.md"), { force: true });
    assert.deepEqual(await sourcesFor(root), before, "grįžus į tą patį medį grįžta ir tas pats rinkinys");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoveredDocsCacheSources: tuščia šaknis nemeta klaidos", async () => {
  const empty = await withTempProject(async () => {
    // Sąmoningai tuščias medis: nė vienos CONTROL_DOC_ROOTS šaknies.
  });
  const emptyDir = await withTempProject(async (dir) => {
    // Šaknis egzistuoja, bet be nė vieno `.md` failo.
    await mkdir(path.join(dir, "docs", "nested"), { recursive: true });
    await writeFile(path.join(dir, "docs", "image.png"), "ne-markdown");
  });
  try {
    assert.deepEqual(await sourcesFor(empty), [], "nesama šaknis — tuščias rinkinys, ne klaida");
    assert.deepEqual(await sourcesFor(emptyDir), [], "tuščias katalogas — tuščias rinkinys, ne klaida");
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test("discoveredDocsCacheSources: tvarka nepriklauso nuo listDirectory eiliškumo", async () => {
  const projectRoot = path.join(os.tmpdir(), "vq-discovered-cache-order-fixture");
  const names = ["a.md", "b.md", "c.md"];

  const ascending = await discoveredDocsCacheSources({ fs: makeOrderedDocsPort(projectRoot, names), projectRoot });
  const descending = await discoveredDocsCacheSources({
    fs: makeOrderedDocsPort(projectRoot, [...names].reverse()),
    projectRoot,
  });

  assert.deepEqual(ascending, descending, "tas pats rinkinys nepriklausomai nuo traversal'o tvarkos");
  assert.deepEqual(
    ascending.map((source) => source.path),
    names.map((name) => `${DISCOVERED_DOCS_SOURCE_PREFIX}docs/${name}`),
  );
});

test("discoveredDocsCacheSources: prefiksas skiria discovered dokumentą nuo to paties įvardyto spec failo", async () => {
  const root = await withTempProject(async (dir) => {
    await mkdir(path.join(dir, "AG", "spec"), { recursive: true });
    await writeFile(path.join(dir, "AG", "spec", "contract.md"), "# Kontraktas\n\nturinys.\n");
  });
  try {
    const sources = await sourcesFor(root);
    assert.deepEqual(
      sources.map((source) => source.path),
      [`${DISCOVERED_DOCS_SOURCE_PREFIX}AG/spec/contract.md`],
      "kelias su prefiksu — plikas `AG/spec/contract.md` priklauso įvardytam spec ref'ui",
    );
    assert.ok(
      sources.every((source) => source.path !== "AG/spec/contract.md"),
      "be prefikso tas pats kelias rinkinyje atsirastų du kartus su skirtingais hash'ais",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
