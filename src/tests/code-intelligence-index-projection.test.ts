// Darbo sričių atpažinimas: `packageDirectories` privalo tikrinti katalogo ribą, ne plikas suffix'ą.
//
// 2026-09-01 (operatoriaus radinys): `file.path.endsWith("package.json")` atitikdavo IR
// `foo/notpackage.json`. Toks failas klaidingai įtraukdavo `foo` į darbo sričių sąrašą, tad
// `foo/src/a.ts` gaudavo owner=`foo`, `src/` prefiksas nusiimdavo, liekana `a.ts` be `/` →
// segmentas `root` → sluoksnis tapdavo `foo/root` vietoj `foo`. Klaidingas sluoksnis keičia
// diagramos struktūrą ir aprėpties matavimą.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectCodeMapFromIndex } from "../application/code-intelligence/code-map/index-projection.js";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { readCodeIndex } from "../application/code-intelligence/store/code-index-store.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";
import type { CodeIndexData } from "../application/code-intelligence/indexing/types.js";

async function indexOf(files: Record<string, string>): Promise<{ root: string; data: CodeIndexData }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-index-projection-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  await buildCodeIndex(nodeFsTestPort, root);
  return { root, data: await readCodeIndex(nodeFsTestPort, root) };
}

test("`foo/notpackage.json` NEsukuria darbo srities — suffix be katalogo ribos neatitinka", async () => {
  const { root, data } = await indexOf({
    "foo/notpackage.json": JSON.stringify({ name: "not-a-workspace" }),
    "foo/src/a.ts": "export const a = 1;\n",
  });
  try {
    const { files } = projectCodeMapFromIndex(data);
    const entry = files.find((file) => file.filePath === "foo/src/a.ts");
    assert.equal(entry?.layer, "foo", "be tikro package.json `foo` nėra darbo sritis — sluoksnis lieka pirmas segmentas po repo šaknies");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tikras `foo/package.json` sukuria darbo sritį — sluoksnis kvalifikuojamas jos vardu", async () => {
  const { root, data } = await indexOf({
    "foo/package.json": JSON.stringify({ name: "foo" }),
    "foo/src/a.ts": "export const a = 1;\n",
  });
  try {
    const { files } = projectCodeMapFromIndex(data);
    const entry = files.find((file) => file.filePath === "foo/src/a.ts");
    assert.equal(entry?.layer, "foo/root", "tikras package.json daro `foo` darbo sritimi — sluoksnis: darbo sritis + segmentas po `src/`");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("šaknies `package.json` (be katalogo) toliau duoda šaknies darbo sritį", async () => {
  const { root, data } = await indexOf({
    "package.json": JSON.stringify({ name: "root" }),
    "src/app/main.ts": "export const main = 1;\n",
  });
  try {
    const { files } = projectCodeMapFromIndex(data);
    const entry = files.find((file) => file.filePath === "src/app/main.ts");
    assert.equal(entry?.layer, "app", "šaknies package.json elgesys nekeičiamas");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
