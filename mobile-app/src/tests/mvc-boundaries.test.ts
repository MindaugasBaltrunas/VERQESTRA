import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * NUKRYPIMAI nuo etalono (`mva-boundaries.test.ts`):
 *  - MVA → MVC: `composition/` sluoksnis dabar `controller/`, tad draudžiamų Model importų
 *    sąraše pasikeitė vienas vardas;
 *  - keliai skaičiuojami nuo modulio, ne nuo `process.cwd()` — kitame workspace pakete
 *    paleistas bėgimas kitaip tyliai perskaitytų svetimą `src` arba nieko;
 *  - paketų vardai `@ag-loop/*` → `@verqestra/*`;
 *  - GRIEŽTINIMAS: pridėta taisyklė `view/** ↛ controller/**`. VERQESTRA'oje `*ViewState`
 *    tipai iškelti iš presenterių į `view/`, tad rodyklė eina `controller → view`; be šito
 *    varto niekas nesulaikytų atgalinės — ekrano, kuris pasiekia projekcijos funkciją vien
 *    dėl to, kad jam prireikė jos tipo.
 */

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const coreSourceRoot = path.join(packageRoot, "src");
const nativePackageRoot = path.join(packageRoot, "native");
const nativeShellRoot = path.join(nativePackageRoot, "src");
const corePackageName = "@verqestra/mobile-app";

async function files(root: string, extensions: readonly string[] = [".ts"]): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return files(absolute, extensions);
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)) ? [absolute] : [];
  }))).flat();
}

/**
 * Layer directories are matched as whole path segments, never as substrings: a
 * Model module may legitimately be named `session-review-read.ts`, and the
 * "view" inside "review" is not the View layer.
 */
const forbiddenModelLayerImport = /from\s+["'](?:[^"']*\/)?(?:view|adapters|controller)\//i;

/** The one direction the extracted view-state types could be re-inverted in. */
const forbiddenViewLayerImport = /from\s+["'](?:[^"']*\/)?(?:controller|adapters)\//i;

test("the Model layer matcher recognises a real layer import, and only that", () => {
  // Without this, a matcher loosened to stop tripping over a file name could go
  // vacuous and the scan below would pass on an actual violation.
  for (const violation of [
    'from "../view/contracts.js"',
    'from "../controller/presentation/ag-loop-presenter.js"',
    'from "../../src/controller/terminal-controller.js"',
  ]) {
    assert.match(violation, forbiddenModelLayerImport, violation);
  }
  for (const allowed of [
    'from "./session-review-read.js"',
    'from "./ag-loop-read.js"',
    'from "./state.js"',
  ]) {
    assert.doesNotMatch(allowed, forbiddenModelLayerImport, allowed);
  }
});

test("MVC model has no View, Controller, Adapter, React Native or transport imports", async () => {
  const modelRoot = path.join(coreSourceRoot, "model");
  for (const file of await files(modelRoot)) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, forbiddenModelLayerImport, file);
    assert.doesNotMatch(text, /from\s+["'](?:react|react-native|expo|node:)/i, file);
    assert.doesNotMatch(text, /\bfetch\s*\(|\bWebSocket\b|\bAsyncStorage\b/, file);
  }
});

test("View contracts import Model types only, and never a controller or an adapter", async () => {
  const viewRoot = path.join(coreSourceRoot, "view");
  const scanned = await files(viewRoot);
  assert.ok(scanned.length > 0, `no View sources under ${viewRoot}`);
  for (const file of scanned) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /model\/(?:use-cases|reducer|ports)|adapters\/(?:api|native|speech|secure-storage)/i, file);
    // The strengthening: the projection imports the view type, never the reverse.
    assert.doesNotMatch(text, forbiddenViewLayerImport, file);
  }
});

// A file renamed to `.js` must not become invisible to the boundary scan.
const sourceExtensions = [".ts", ".tsx", ".js", ".jsx"] as const;

/**
 * Every module specifier form the shell can actually use: static `from "x"`,
 * side-effect and dynamic `import("x")`, re-export `export ... from "x"`, and
 * CommonJS `require("x")`. Matching raw text per form kept missing the
 * `require()`/`import()` variants, so the rules below assert on the extracted
 * specifier and never on the surrounding source line.
 */
const moduleSpecifierPattern = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

function moduleSpecifiers(text: string): string[] {
  return [...text.matchAll(moduleSpecifierPattern)].flatMap((match) => match[1] ?? []);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Absolute target of a relative specifier; `undefined` for bare package names. */
function relativeTarget(file: string, specifier: string): string | undefined {
  return specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : undefined;
}

async function nativeShellFiles(): Promise<string[]> {
  // A missing directory must fail the suite: the native shell scaffold is required.
  const found = await files(nativeShellRoot, sourceExtensions);
  assert.ok(found.length > 0, `no native shell sources under ${nativeShellRoot}`);
  return found;
}

/**
 * Platform module specifiers. The boundary is the whole package family, not the
 * three bare names: `react-native-keychain`, `expo-secure-store` and
 * `expo-local-authentication` are exactly the modules a secure-storage or
 * biometric adapter reaches for, and a matcher anchored on `/` or end-of-string
 * would have let every one of them into the platform-independent core.
 */
const platformPackage = /^(?:react|react-native|expo)(?:[/-]|$)/i;
const platformPackageImport = /from\s+["'](?:react|react-native|expo)(?:[/-][^"']*)?["']/i;

test("the platform matcher covers the whole package family, not just the bare names", () => {
  for (const violation of [
    "react",
    "react-native",
    "react-native/Libraries/Text",
    "react-native-keychain",
    "expo-secure-store",
    "expo-local-authentication",
    "expo/vector-icons",
  ]) {
    assert.match(violation, platformPackage, violation);
    assert.match(`from "${violation}"`, platformPackageImport, violation);
  }
  for (const allowed of ["node:crypto", "reactive-store", "../model/ports.js"]) {
    assert.doesNotMatch(allowed, platformPackage, allowed);
  }
});

test("MVC core never imports the native shell", async () => {
  // Only this suite is exempt, because its own regex literals name the very
  // specifiers it forbids; every other core source, tests included, is scanned.
  const selfFile = path.join(coreSourceRoot, "tests", "mvc-boundaries.test.ts");
  const scanned = await files(coreSourceRoot, sourceExtensions);
  assert.ok(scanned.length > 0, `no MVC core sources under ${coreSourceRoot}`);

  let inspectedSpecifiers = 0;
  for (const file of scanned) {
    if (file === selfFile) continue;
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, platformPackageImport, file);
    // Only the native *package* is forbidden by name. A bare `native/` segment
    // would also hit `src/adapters/native/...`, which the View test above treats
    // as a legitimate core directory.
    assert.doesNotMatch(text, /from\s+["'][^"']*@verqestra\/mobile-app-native[^"']*["']/i, file);

    for (const specifier of moduleSpecifiers(text)) {
      inspectedSpecifiers += 1;
      assert.doesNotMatch(specifier, platformPackage, `${file}: ${specifier}`);
      assert.doesNotMatch(specifier, /@verqestra\/mobile-app-native/i, `${file}: ${specifier}`);
      const target = relativeTarget(file, specifier);
      assert.ok(
        target === undefined || !isInside(nativePackageRoot, target),
        `${file}: core reaches into the native shell via ${specifier}`,
      );
    }
  }
  // Guards against a silently vacuous scan if the extractor ever stops matching.
  assert.ok(inspectedSpecifiers > 0, "no module specifiers extracted from the MVC core");
});

test("Native shell reaches the MVC core only through its public barrel", async () => {
  const seamFile = path.join(nativeShellRoot, "core.ts");
  const shellFiles = await nativeShellFiles();
  assert.ok(shellFiles.includes(seamFile), `missing native shell seam module: ${seamFile}`);

  for (const file of shellFiles) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(
      text,
      /from\s+["'](?:@verqestra\/mobile-app\/(?:src|dist)|\.\.\/\.\.\/(?:src|dist)\/)[^"']*["']/i,
      file,
    );
    if (file !== seamFile) {
      assert.doesNotMatch(text, /from\s+["']@verqestra\/mobile-app["']/, file);
    }

    for (const specifier of moduleSpecifiers(text)) {
      const target = relativeTarget(file, specifier);
      if (target !== undefined) {
        // Any relative hop out of `native/` bypasses the barrel, at any depth:
        // `../../src/...` and `../../../src/...` are the same violation.
        assert.ok(
          isInside(nativePackageRoot, target),
          `${file}: relative specifier escapes the native package: ${specifier}`,
        );
        continue;
      }
      assert.ok(
        !specifier.startsWith(`${corePackageName}/`),
        `${file}: deep core import bypasses the barrel: ${specifier}`,
      );
      if (file === seamFile) continue;
      assert.notEqual(specifier, corePackageName, `${file}: only the seam module may use ${corePackageName}`);
    }
  }
});

test("Native shell never imports the orchestrator or the mobile gateway", async () => {
  for (const file of await nativeShellFiles()) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /(?:from|require\()\s*["'][^"']*(?:mobile-gateway|orchestrator)[^"']*["']/i, file);
    for (const specifier of moduleSpecifiers(text)) {
      assert.doesNotMatch(specifier, /mobile-gateway|orchestrator/i, `${file}: ${specifier}`);
    }
  }
});

/**
 * GRIEŽTINIMAS: etalonas 500 eilučių taisyklės neturėjo, tad jo `mva-boundaries.test.ts` jos
 * ir netikrino. VERQESTRA'oje ji yra `CLAUDE.md` reikalavimas — o reikalavimas, kurio niekas
 * nepaleidžia, yra pažadas: šitas paketas migracijos metu jį pažeidė septyniuose failuose ir
 * niekas nebūtų pasakęs. Tas pats vartas veikia `mobile-gateway`; skaičiavimas tapatus, tad
 * baigiamasis LF nėra eilutė nė viename pakete.
 */
const MAX_FILE_LINES = 500;

function countLines(content: string): number {
  if (content === "") return 0;
  const parts = content.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

test("the line counter does not count a trailing newline as a line", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\n"), 1);
  assert.equal(countLines("one\ntwo"), 2);
  assert.equal(countLines("one\ntwo\n"), 2);
});

test("no mobile source file exceeds the size gate", async () => {
  const scanned = [
    ...await files(coreSourceRoot, sourceExtensions),
    ...await files(nativeShellRoot, sourceExtensions),
  ];
  assert.ok(scanned.length > 40, `only ${scanned.length} mobile sources scanned`);

  const oversized: string[] = [];
  for (const file of scanned) {
    const lines = countLines(await readFile(file, "utf8"));
    if (lines > MAX_FILE_LINES) {
      oversized.push(`${path.relative(packageRoot, file)}: ${lines}`);
    }
  }
  assert.deepEqual(oversized, [], `files over ${MAX_FILE_LINES} lines`);
});
