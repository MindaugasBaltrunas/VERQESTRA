// Savipatikra vien sintetiniais įėjimais — jokio FS. Tikrina `dead-export-gate-scan.ts`,
// kuris ruošia KELIŲ (ne vardų) lygio našlaičių paiešką: pilnas failo dublikatas su
// bendravardžiais eksportais token'iniam `dead-export-gate.test.ts` vartui nematomas iš
// principo, nes abi kopijos „patvirtina" viena kitą per simbolio vardą. Šis testas įrodo, kad
// kelių lygio patikra tą spragą uždaro, ir kad ji neįveda naujų klaidingų teigiamų (barrel'io
// taikinys, entrypoint'as, testų failai).
import assert from "node:assert/strict";
import test from "node:test";
import { collectImportSpecifiers, findOrphanFiles, resolveSpecifier } from "./helpers/dead-export-gate-scan.js";

test("collectImportSpecifiers: static, re-export ir dinaminis import", () => {
  const source = [
    'import { a } from "./a.js";',
    'import b from "./b.js";',
    'import "./side-effect.js";',
    'export { c } from "./c.js";',
    'export * from "./barrel.js";',
    'const lazy = await import("./lazy.js");',
    'import external from "external-package";',
  ].join("\n");

  assert.deepEqual(collectImportSpecifiers(source), [
    "./a.js",
    "./b.js",
    "./side-effect.js",
    "external-package",
    "./c.js",
    "./barrel.js",
    "./lazy.js",
  ]);
});

test("resolveSpecifier: santykinis .js -> repo-santykinis .ts, ne-santykinis -> undefined", () => {
  assert.equal(resolveSpecifier("application/foo/bar.ts", "./baz.js"), "application/foo/baz.ts");
  assert.equal(resolveSpecifier("application/foo/bar.ts", "../shared/util.js"), "application/shared/util.ts");
  assert.equal(resolveSpecifier("application/foo/bar.ts", "external-package"), undefined);
  assert.equal(resolveSpecifier("application/foo/bar.ts", "node:path"), undefined);
});

test("findOrphanFiles: našlaitis su bendravardžiais eksportais randamas (token'inis vartas jo nemato)", () => {
  const files = [
    { relative: "application/foo/live.ts", source: 'export function doThing() {}\nimport { helper } from "./helper.js";' },
    { relative: "application/foo/helper.ts", source: "export function helper() {}" },
    // Pilnas dublikatas: TA PATI eksportuojama funkcija, jokio kvietėjo per kelią.
    { relative: "application/bar/orphan.ts", source: "export function helper() {}" },
  ];

  const orphans = findOrphanFiles(files, new Set(["application/foo/live.ts"]));

  assert.deepEqual(orphans, ["application/bar/orphan.ts"]);
});

test("findOrphanFiles: failas pasiekiamas TIK per `export * from` barrel NErandamas", () => {
  const files = [
    { relative: "composition/index.ts", source: 'export * from "./target.js";' },
    { relative: "composition/target.ts", source: "export function doThing() {}" },
  ];

  const orphans = findOrphanFiles(files, new Set(["composition/index.ts"]));

  assert.deepEqual(orphans, []);
});

test("findOrphanFiles: entrypoint sąraše esantis failas NErandamas net be jokio importuotojo", () => {
  const files = [{ relative: "cli.ts", source: "export function main() {}" }];

  const orphans = findOrphanFiles(files, new Set(["cli.ts"]));

  assert.deepEqual(orphans, []);
});

test("findOrphanFiles: tests/ failai kandidatais neskaičiuojami", () => {
  const files = [{ relative: "tests/some.test.ts", source: "export function neverImported() {}" }];

  const orphans = findOrphanFiles(files, new Set());

  assert.deepEqual(orphans, []);
});
