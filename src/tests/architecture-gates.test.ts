// Fail-closed architecture gates — from the FIRST commit, with NO baseline (VRQ-3).
// One suite, four gates: classification, file-length, layer boundaries, cycles.
// Plus the hygiene rule AG_loop learned the hard way (VQ-002: six source files were
// invisible to ripgrep over encoding): no CR, no NUL, NFC-normalized source only.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SRC_ROOT = path.resolve(process.cwd(), "src");
const MAX_LINES_PER_FILE = 500;
const NUL = String.fromCharCode(0);

const LAYERS = ["shared", "domain", "application", "infrastructure", "interfaces", "composition", "tests"] as const;
type Layer = (typeof LAYERS)[number];

/** Which layers each layer may import (by top-level src segment). */
const ALLOWED_LAYER_IMPORTS: Record<Layer, readonly Layer[]> = {
  shared: ["shared"],
  domain: ["domain", "shared"],
  application: ["application", "domain", "shared"],
  infrastructure: ["infrastructure", "application", "domain", "shared"],
  interfaces: ["interfaces", "application", "domain", "shared"],
  composition: ["composition", "interfaces", "infrastructure", "application", "domain", "shared"],
  tests: ["tests", "composition", "interfaces", "infrastructure", "application", "domain", "shared"],
};

/** node: builtins a layer may touch. Pure layers get none / primitives only. */
const ALLOWED_NODE_BUILTINS: Partial<Record<Layer, readonly string[]>> = {
  domain: [],
  shared: ["node:crypto", "node:path"],
  application: ["node:crypto", "node:path"],
};

type SourceFile = {
  /** src-relative POSIX path, e.g. "domain/tasks/rules.ts". */
  relative: string;
  layer: Layer | "entrypoint";
  content: string;
};

async function collectSourceFiles(dir: string, relativePrefix: string, out: SourceFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = relativePrefix === "" ? entry.name : `${relativePrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectSourceFiles(path.join(dir, entry.name), relative, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const topSegment = relative.split("/")[0] ?? "";
    const layer: Layer | "entrypoint" | undefined =
      relative === "cli.ts" ? "entrypoint" : (LAYERS as readonly string[]).includes(topSegment) ? (topSegment as Layer) : undefined;
    assert.ok(layer !== undefined, `classification gate: ${relative} does not belong to any known layer (${LAYERS.join(", ")}) or cli.ts`);
    out.push({ relative, layer, content: await readFile(path.join(dir, entry.name), "utf8") });
  }
}

function countLines(content: string): number {
  if (content === "") return 0;
  const parts = content.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;

function importSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const match of content.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/** Resolves a relative specifier to a src-relative POSIX .ts path, or undefined for packages. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const fromDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const joined = path.posix.normalize(path.posix.join(fromDir, specifier));
  return joined.endsWith(".js") ? `${joined.slice(0, -3)}.ts` : `${joined}.ts`;
}

function layerOf(relative: string): Layer | "entrypoint" {
  if (relative === "cli.ts") return "entrypoint";
  const top = relative.split("/")[0] ?? "";
  return (LAYERS as readonly string[]).includes(top) ? (top as Layer) : "entrypoint";
}

const files: SourceFile[] = [];
await collectSourceFiles(SRC_ROOT, "", files);

test("gate: the scan sees the source tree", () => {
  assert.ok(files.length > 0, "no source files found — the gate scan root is wrong");
});

test("gate: source hygiene — LF only, no NUL, NFC-normalized", () => {
  for (const file of files) {
    assert.ok(!file.content.includes("\r"), `${file.relative}: CRLF is forbidden`);
    assert.ok(!file.content.includes(NUL), `${file.relative}: NUL byte makes the file invisible to text tooling`);
    assert.equal(file.content.normalize("NFC"), file.content, `${file.relative}: source must be NFC-normalized`);
  }
});

test(`gate: file-length — every source file <= ${MAX_LINES_PER_FILE} lines, no baseline`, () => {
  const over = files
    .map((file) => ({ file: file.relative, lines: countLines(file.content) }))
    .filter((entry) => entry.lines > MAX_LINES_PER_FILE);
  assert.deepEqual(over, [], `split these files by responsibility — a baseline does not exist by construction`);
});

test("gate: layer boundaries — import direction and node builtin policy", () => {
  const violations: string[] = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(file.content)) {
      const resolved = resolveRelative(file.relative, specifier);
      if (resolved !== undefined) {
        const targetLayer = layerOf(resolved);
        if (file.layer === "entrypoint") continue; // cli.ts may import anything — it is the wiring seam.
        if (targetLayer === "entrypoint") {
          violations.push(`${file.relative} -> cli.ts (nothing imports the entrypoint)`);
          continue;
        }
        if (targetLayer === "composition" && file.layer !== "composition" && file.layer !== "tests") {
          violations.push(`${file.relative} -> ${resolved} (only cli.ts, composition and tests may import composition)`);
          continue;
        }
        if (!ALLOWED_LAYER_IMPORTS[file.layer].includes(targetLayer)) {
          violations.push(`${file.relative} (${file.layer}) -> ${resolved} (${targetLayer})`);
        }
        continue;
      }
      if (specifier.startsWith("node:") && file.layer !== "entrypoint") {
        const allowed = ALLOWED_NODE_BUILTINS[file.layer];
        if (allowed !== undefined && !allowed.includes(specifier)) {
          violations.push(`${file.relative} (${file.layer}) -> ${specifier} (pure layer may not touch this builtin)`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], "layer boundary violations — the base is zero and stays zero");
});

test("gate: module import graph is acyclic", () => {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const targets: string[] = [];
    for (const specifier of importSpecifiers(file.content)) {
      const resolved = resolveRelative(file.relative, specifier);
      if (resolved !== undefined) targets.push(resolved);
    }
    graph.set(file.relative, targets);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    if (done.has(node)) return;
    assert.ok(!visiting.has(node), `import cycle: ${[...stack, node].join(" -> ")}`);
    visiting.add(node);
    stack.push(node);
    for (const target of graph.get(node) ?? []) visit(target);
    stack.pop();
    visiting.delete(node);
    done.add(node);
  };
  for (const node of graph.keys()) visit(node);
});
