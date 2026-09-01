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
  // The entry is also the composition point: a root registered without props
  // can never receive a port, so the scaffold is only complete once it goes
  // through the platform composition root. `native-runtime.test.ts` owns what
  // that composition must produce.
  assert.match(entry, /composition\/native-runtime/);
  assert.doesNotMatch(entry, /registerRootComponent\(\s*App\s*\)/);

  for (const configFile of ["app.json", "babel.config.js", "metro.config.js"]) {
    const text = await readPackageFile(configFile);
    assert.ok(text.length > 0, `empty config file: ${configFile}`);
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
