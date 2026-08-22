import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Boundary regression gate for BENCH-1.
 *
 * Package root resolved from this module, not from `process.cwd()`: a run
 * started in another workspace package would otherwise scan that package's
 * `src` and pass vacuously.
 */
const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const sourceRoot = path.join(packageRoot, "src");

const LAYERS = ["domain", "application", "infrastructure", "interfaces", "tests"] as const;

type Layer = (typeof LAYERS)[number] | "barrel";

/**
 * What each layer may never reach for. The direction is inward only: a domain
 * that knows about an adapter can no longer be reasoned about without one, and
 * an application that imports a delivery concern cannot be driven by a test.
 */
const FORBIDDEN_TARGETS: Readonly<Partial<Record<Layer, readonly Layer[]>>> = {
  domain: ["application", "infrastructure", "interfaces", "tests"],
  application: ["infrastructure", "interfaces", "tests"],
  infrastructure: ["interfaces", "tests"],
  interfaces: ["tests"],
};

/**
 * AG orchestrator and UI internals. Source form is not the boundary — the build
 * output and the workspace package name are the same violation by another
 * route. Documented AG contracts stay allowed; reaching into an implementation
 * is what turns an internal file into an unofficial API.
 */
const AG_INTERNAL_MODULE =
  /(?:orchestrator[\\/](?:src|dist)|claude-codex-orchestrator|^ag-ui(?:[\\/]|$)|^@ag-loop[\\/](?!benchmark))/i;

/**
 * The domain is pure by construction: its only imports are its own siblings and
 * `node:crypto`, which computes hashes over values already in hand and performs
 * no I/O. Anything else — a filesystem, a process, a socket, a UI runtime —
 * would let whoever controls that resource decide what the domain concludes.
 */
const DOMAIN_ALLOWED_EXTERNAL_MODULES = new Set(["node:crypto"]);

/** `import x from`, `export … from`, bare `import "…"`, `import()` and `require()`. */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s+)["']([^"']+)["']/g;

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(absolute);
      return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
    }),
  );
  return nested.flat();
}

function layerOf(file: string): Layer {
  const [head] = path.relative(sourceRoot, file).split(path.sep);
  return (LAYERS as readonly string[]).includes(head ?? "") ? (head as Layer) : "barrel";
}

interface Reference {
  readonly file: string;
  readonly layer: Layer;
  readonly specifier: string;
}

async function references(): Promise<readonly Reference[]> {
  const files = await sourceFiles(sourceRoot);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(file, "utf8");
      return [...text.matchAll(IMPORT_SPECIFIER)].map((match) => ({
        file,
        layer: layerOf(file),
        specifier: match[1] as string,
      }));
    }),
  );
  return perFile.flat();
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith(".");
}

/** Absolute path a relative specifier points at, with the emitted `.js` mapped back to source. */
function resolveRelative(reference: Reference): string {
  return path.resolve(path.dirname(reference.file), reference.specifier.replace(/\.js$/, ".ts"));
}

test("the package exposes the documented layers and a public barrel", async () => {
  for (const layer of LAYERS) {
    const directory = path.join(sourceRoot, layer);
    assert.ok((await stat(directory)).isDirectory(), `missing layer directory: ${layer}`);
  }
  assert.ok((await stat(path.join(sourceRoot, "index.ts"))).isFile(), "missing public barrel");
});

test("layers depend inward only", async () => {
  for (const reference of await references()) {
    if (!isRelative(reference.specifier)) continue;
    const targetLayer = layerOf(resolveRelative(reference));
    const forbidden = FORBIDDEN_TARGETS[reference.layer] ?? [];
    assert.ok(
      !forbidden.includes(targetLayer),
      `${path.relative(packageRoot, reference.file)} (${reference.layer}) imports upward into ${targetLayer}: ${reference.specifier}`,
    );
  }
});

test("the domain imports nothing but its own modules and node:crypto", async () => {
  for (const reference of await references()) {
    if (reference.layer !== "domain") continue;
    if (isRelative(reference.specifier)) continue;
    assert.ok(
      DOMAIN_ALLOWED_EXTERNAL_MODULES.has(reference.specifier),
      `${path.relative(packageRoot, reference.file)} imports ${reference.specifier}; the domain stays free of I/O, process and UI dependencies`,
    );
  }
});

test("no source file reaches outside the package source tree", async () => {
  for (const reference of await references()) {
    if (!isRelative(reference.specifier)) continue;
    const outside = path.relative(sourceRoot, resolveRelative(reference));
    assert.ok(
      !outside.startsWith("..") && !path.isAbsolute(outside),
      `${path.relative(packageRoot, reference.file)} escapes src via ${reference.specifier}`,
    );
  }
});

test("no source file imports AG orchestrator or UI internals", async () => {
  for (const reference of await references()) {
    assert.doesNotMatch(
      reference.specifier,
      AG_INTERNAL_MODULE,
      `${path.relative(packageRoot, reference.file)} imports an AG internal module`,
    );
  }
});

test("the public barrel covers every layer consumers may use", async () => {
  const barrel = await readFile(path.join(sourceRoot, "index.ts"), "utf8");
  const exported = new Set(
    [...barrel.matchAll(IMPORT_SPECIFIER)].map((match) =>
      layerOf(path.resolve(sourceRoot, (match[1] as string).replace(/\.js$/, ".ts"))),
    ),
  );
  for (const layer of ["domain", "application", "infrastructure", "interfaces"] as const) {
    assert.ok(exported.has(layer), `the public barrel exports nothing from ${layer}`);
  }
  assert.ok(!exported.has("tests"), "the public barrel exports a test module");
});
