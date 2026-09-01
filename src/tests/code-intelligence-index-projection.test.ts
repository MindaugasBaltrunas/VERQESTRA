// Darbo sričių riba: `packageDirectories` (index-projection.ts) turi atpažinti INDEKSUOTĄ
// `package.json`, ne bet kurį failą, kurio vardas TAIP BAIGIASI.
//
// Iškelta kaip atskiras testų failas nuo `code-intelligence-code-map.test.ts` (task 098 tuo pačiu
// keliu dirba su `coverage.ts`/`generator.ts`) — bendras kelias abiem užduotims atimtų lygiagretumą.
//
// 2026-09-01 (operatoriaus radinys, task 100): `packageDirectories` tikrino
// `file.path.endsWith("package.json")` — suffix'as be katalogo ribos. `foo/notpackage.json`
// klaidingai sukurdavo darbo sritį `foo`, ir `foo/src/a.ts` gaudavo sluoksnį `foo/root` vietoj
// `foo` (žr. `layerForPath` — `src/` prefiksas nusiimamas, liekana be `/` tampa `root`).
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

test("darbo sritis: `notpackage.json` NĖRA manifestas — suffix'as be katalogo ribos neapgauna", async () => {
  const { root, data } = await indexOf({
    "foo/notpackage.json": JSON.stringify({ note: "ne manifestas" }),
    "foo/src/a.ts": "export const a = 1;\n",
  });
  try {
    const { files } = projectCodeMapFromIndex(data);
    const file = files.find((entry) => entry.filePath === "foo/src/a.ts");
    assert.equal(file?.layer, "foo", "`foo/notpackage.json` neturi sukurti darbo srities `foo`");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("darbo sritis: tikras `package.json` katalogo viduje sukuria darbo sritį", async () => {
  const { root, data } = await indexOf({
    "foo/package.json": JSON.stringify({ name: "foo" }),
    "foo/src/a.ts": "export const a = 1;\n",
  });
  try {
    const { files } = projectCodeMapFromIndex(data);
    const file = files.find((entry) => entry.filePath === "foo/src/a.ts");
    assert.equal(file?.layer, "foo/root", "tikras manifestas kvalifikuoja sluoksnį darbo sritimi");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("darbo sritis: šaknies `package.json` toliau duoda šaknies darbo sritį", async () => {
  const { root, data } = await indexOf({
    "package.json": JSON.stringify({ name: "root" }),
    "src/app/main.ts": "export const main = 1;\n",
  });
  try {
    const { files } = projectCodeMapFromIndex(data);
    const file = files.find((entry) => entry.filePath === "src/app/main.ts");
    assert.equal(file?.layer, "app", "šaknies manifestas — elgesys nekinta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
