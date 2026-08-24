import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * Completeness of the single seam module.
 *
 * `mvc-boundaries.test.ts` proves the shell reaches the core only through
 * `native/src/core.ts`. It cannot prove the seam actually re-exports what the
 * shell asks it for: a screen importing a symbol the allowlist forgot compiles
 * only where `react-native` and `expo` are installed, so on a machine without
 * them the break surfaces first in CI or on a device.
 *
 * This suite closes that gap with plain text: every identifier any shell file
 * imports from `./core` must appear in the seam's export lists.
 *
 * NUKRYPIMAS (kelias, ne taisyklės): etalonas skaičiavo `process.cwd()`. Šis paketas
 * kompiliuojamas į CommonJS (`package.json` sąmoningai be `"type": "module"`, nes Metro ir
 * Babel jį krauna `require`'u), tad `import.meta.url` čia neegzistuoja — modulio kelią duoda
 * `__dirname`. Nauda ta pati: bėgimas iš kito workspace paketo nebeperskaito svetimo `src`.
 */

const nativeRoot = path.resolve(__dirname, "..", "..");
const shellRoot = path.join(nativeRoot, "src");
const seamFile = path.join(shellRoot, "core.ts");

const sourceExtensions = [".ts", ".tsx"] as const;

async function shellFiles(root: string = shellRoot): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return shellFiles(absolute);
    return entry.isFile() && sourceExtensions.some((extension) => entry.name.endsWith(extension))
      ? [absolute]
      : [];
  }))).flat();
}

/**
 * Names inside one `{ ... }` clause: `type` prefixes are dropped and an aliased
 * import is recorded under the name the seam has to export, not the local one.
 */
function clauseNames(clause: string): string[] {
  return clause
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const exported = entry.split(/\s+as\s+/)[0] ?? entry;
      return exported.replace(/^type\s+/, "").trim();
    })
    .filter((name) => name.length > 0);
}

/**
 * Both list forms the seam uses; the module specifier is deliberately not
 * matched. The clause may not contain a brace: `[\s\S]*?` would let one import
 * statement's opening brace pair with a later statement's closing one.
 */
const seamExportPattern = /export\s+(?:type\s+)?\{([^}]*)\}/g;

/** Imports of the seam from anywhere in the shell, at any relative depth. */
const seamImportPattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](?:\.{1,2}\/)+core["']/g;

async function seamExports(): Promise<ReadonlySet<string>> {
  const text = await readFile(seamFile, "utf8");
  const exported = new Set<string>();
  for (const match of text.matchAll(seamExportPattern)) {
    for (const name of clauseNames(match[1] ?? "")) exported.add(name);
  }
  assert.ok(exported.size > 0, "no exports extracted from the seam module");
  return exported;
}

test("the seam re-exports every core symbol the shell imports", async () => {
  const exported = await seamExports();
  const files = await shellFiles();
  assert.ok(files.length > 0, `no native shell sources under ${shellRoot}`);

  // This suite is exempt from its own scan, for the same reason the boundary
  // suite exempts itself: its fixtures spell out the very import forms it looks
  // for, and they name no real core symbol.
  const selfFile = path.join(shellRoot, "tests", "core-seam.test.ts");

  let inspected = 0;
  for (const file of files) {
    if (file === seamFile || file === selfFile) continue;
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(seamImportPattern)) {
      for (const name of clauseNames(match[1] ?? "")) {
        inspected += 1;
        assert.ok(
          exported.has(name),
          `${path.relative(shellRoot, file)} imports ${name} from the seam, which does not export it`,
        );
      }
    }
  }
  // Guards against a silently vacuous scan if the extractor stops matching.
  assert.ok(inspected > 0, "no seam imports extracted from the native shell");
});

test("the import extractor recognises the forms the shell actually uses", () => {
  assert.deepEqual(
    clauseNames("AgLoopReadController,\n  initialAppState,\n  presentDashboard,"),
    ["AgLoopReadController", "initialAppState", "presentDashboard"],
  );
  assert.deepEqual(clauseNames("type AppState, AppEvent"), ["AppState", "AppEvent"]);
  assert.deepEqual(clauseNames("Provider as AgentProvider"), ["Provider"]);

  const sample = [
    'import { presentTasks } from "../core";',
    'import type {',
    '  TasksViewProps,',
    '} from "./core";',
  ].join("\n");
  const found = [...sample.matchAll(seamImportPattern)].flatMap((match) => clauseNames(match[1] ?? ""));
  assert.deepEqual(found, ["presentTasks", "TasksViewProps"]);
});
