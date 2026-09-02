import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Node-only scaffold checks: this suite never loads React, Expo or the MVC core,
// so it stays runnable in CI without a device toolchain.
//
// NUKRYPIMAS (kelias, ne taisyklės): `process.cwd()` → `__dirname` (žr. `core-seam.test.ts`).

const packageRoot = path.resolve(__dirname, "..", "..");
const corePackageName = "@verqestra/mobile-app";

type NativeManifest = Readonly<{
  main?: string;
  type?: string;
  dependencies?: Readonly<Record<string, string>>;
}>;

type AppTsconfig = Readonly<{
  compilerOptions?: Readonly<{ paths?: Readonly<Record<string, readonly string[]>> }>;
}>;

async function readPackageFile(relative: string): Promise<string> {
  return readFile(path.resolve(packageRoot, relative), "utf8");
}

test("native package declares the MVC core as a workspace dependency", async () => {
  const manifest = JSON.parse(await readPackageFile("package.json")) as NativeManifest;
  const dependencies = manifest.dependencies ?? {};

  assert.equal(dependencies[corePackageName], "workspace:*");
  for (const runtimeDependency of ["expo", "react", "react-native"]) {
    assert.ok(dependencies[runtimeDependency], `missing dependency: ${runtimeDependency}`);
  }
  assert.equal(manifest.main, "index.js");
  // Metro and Babel load index.js/metro.config.js/babel.config.js with `require`.
  assert.equal(manifest.type, undefined);
});

test("Expo entry and native config files exist", async () => {
  const entry = await readPackageFile("index.js");
  assert.match(entry, /registerRootComponent\s*\(/);

  for (const configFile of ["app.json", "babel.config.js", "metro.config.js"]) {
    const text = await readPackageFile(configFile);
    assert.ok(text.length > 0, `empty config file: ${configFile}`);
  }
});

test("the Expo entry stays CommonJS, the way Metro and Babel load it", async () => {
  const entry = await readPackageFile("index.js");

  assert.match(entry, /^\/\/ Expo entry point\./, "the CommonJS entry note must stay on line 1");
  assert.match(entry, /require\("expo"\)/);
  assert.doesNotMatch(entry, /^\s*(import|export)\s/m, "ESM syntax would break the CommonJS entry");
});

test("the Expo entry registers App through a props-building root, not App itself", async () => {
  const entry = await readPackageFile("index.js");

  // Registering `App` directly hands it the native launcher's initialProps,
  // which are not `AppProps`. The root is what the entry composes.
  assert.doesNotMatch(entry, /registerRootComponent\(\s*App\s*\)/);
  assert.match(entry, /function Root\(\)/);
  assert.match(entry, /registerRootComponent\(Root\)/);
  assert.match(entry, /createElement\(\s*App\s*,\s*createAppProps\(\)\s*\)/);
});

test("the Expo entry builds App props in one place and constructs no ports itself", async () => {
  const entry = await readPackageFile("index.js");

  const factoryStart = entry.indexOf("function createAppProps()");
  const factoryEnd = entry.indexOf("function Root()");
  assert.ok(factoryStart >= 0 && factoryEnd > factoryStart, "no createAppProps factory in the entry");
  const factory = entry.slice(entry.indexOf("{", factoryStart), factoryEnd);

  // The entry is an injection point, not an adapter: props may only be values a
  // composition module produced. A `new X(...)` or an inline object with methods
  // would be a port fabricated right here — the one thing that would turn the
  // screens' honest "not wired" reports into a lie.
  assert.doesNotMatch(factory, /=>|\bfunction\b/, "the props factory defines a port inline");
  assert.doesNotMatch(entry, /\bnew\s+[A-Z]/);
  assert.doesNotMatch(entry, /@verqestra\/mobile-app/);
});

test("the entry reaches the core only through the shell it registers", async () => {
  const entry = await readPackageFile("index.js");

  const allowedRequires = new Set(["expo", "react", "./src/App"]);
  const requires = [...entry.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? "");
  assert.ok(requires.length > 0, "no require calls found in the entry");
  for (const specifier of requires) {
    // Ports may only arrive from a composition module; everything else here
    // would be the entry taking on adapter work of its own.
    const fromComposition = specifier.startsWith("./src/composition/");
    assert.ok(
      allowedRequires.has(specifier) || fromComposition,
      `unexpected require in the Expo entry: ${specifier}`,
    );
  }
});

test("every AppProps port the entry omits is one App still reports as unwired", async () => {
  const appSource = await readPackageFile(path.join("src", "App.tsx"));
  const contract = appSource.slice(
    appSource.indexOf("export type AppProps"),
    appSource.indexOf("type Space"),
  );

  // The entry may pass a subset; the contract has to keep every port optional so
  // that a missing adapter degrades into an honest screen instead of a crash.
  for (const portName of ["agLoopReads", "sessionReviewReads", "connectionsReads", "projectsReads", "terminal"]) {
    assert.match(
      contract,
      new RegExp(`\\b${portName}\\?:`),
      `AppProps no longer declares ${portName} as optional`,
    );
  }
});

test("Metro declares the temporary runtime seam for the MVC core", async () => {
  const metroConfig = await readPackageFile("metro.config.js");

  assert.match(metroConfig, /extraNodeModules/);
  assert.ok(metroConfig.includes(corePackageName), "Metro does not map the core package");
});

test("app typecheck config maps the MVC core to the core package sources", async () => {
  const appTsconfig = JSON.parse(await readPackageFile("tsconfig.json")) as AppTsconfig;
  const paths = appTsconfig.compilerOptions?.paths ?? {};

  const mapping = paths[corePackageName];
  assert.ok(mapping && mapping.length > 0, "tsconfig paths do not map the core package");
  assert.match(mapping[0] ?? "", /\.\.\/src\/index\.ts$/);
});
