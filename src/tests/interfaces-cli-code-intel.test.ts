// VQ-501 (3/5-a) testai — code-intelligence CLI klasteris per fake portus: code-graph
// užklausos rendinimas (top-20/--json/--fuzzy), code-index check/architecture-check
// (freshness vartas + boundary politika), context-pack rendinimas virš assemble porto.
// `code-index build` čia netestuojamas — pilną build kelią dengia application
// code-intelligence testai (TS indexer'iui reikia realios failų sistemos).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { CodeIntelligenceFileSystemPort } from "../application/code-intelligence/ports.js";
import { codeIndexPath, computeRecordsHash } from "../application/code-intelligence/store/code-index-store.js";
import { computeSourceHash } from "../application/code-intelligence/indexing/scanner.js";
import { codeIndexVersion } from "../application/code-intelligence/indexing/types.js";
import type { PolicyConfigFileSystemPort } from "../application/policy-governance/ports.js";
import {
  contextPackSchema,
  executionContextSchema,
} from "../application/context-pack/context-pack-schema.js";
import type {
  AssembleContextPackDeps,
  ContextPackResult,
} from "../application/context-pack/assemble/assemble.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import { codeGraphCommand } from "../interfaces/cli/code-intel/code-graph.js";
import { codeIndexCommand } from "../interfaces/cli/code-intel/code-index.js";
import { contextPackCommand } from "../interfaces/cli/code-intel/context-pack.js";

const ROOT = path.resolve("/repo");
const norm = (p: string): string => p.replace(/\\/g, "/");

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

function makeCodeFs(files: Map<string, string>): CodeIntelligenceFileSystemPort {
  return {
    listDirectory: async () => [],
    statKind: async (p) => (files.has(norm(p)) ? "file" : "absent"),
    readTextFile: async (p) => {
      const text = files.get(norm(p));
      if (text === undefined) throw new Error(`ENOENT: ${p}`);
      return text;
    },
    readFileBytes: async () => new Uint8Array(),
    fileSize: async () => 0,
    exists: async (p) => files.has(norm(p)),
    writeTextFileAtomic: async (p, content) => {
      files.set(norm(p), content);
    },
    makeDirectory: async () => {},
  };
}

function makePolicyFs(files: Map<string, string>): PolicyConfigFileSystemPort {
  return { readTextFileIfExists: async (p) => files.get(norm(p)) };
}

const jsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join("\n");

// Index fixture: tuščias skenas (listDirectory → []) duoda tuščią source hash, tad
// manifest'as su tuo pačiu hash'u yra ŠVIEŽIAS — freshness vartas praeina be realios FS.
async function makeIndexedFs(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const sourceHash = await computeSourceHash([]);
  const fileBase = { hash: "h", size: 10, exports: [], symbols: [] };
  const indexFiles = [
    {
      path: "src/interfaces/cli/a.ts",
      language: "typescript",
      kind: "source",
      imports: ["src/infrastructure/fs/b.ts"],
      isTest: false,
      ...fileBase,
    },
    {
      path: "src/infrastructure/fs/b.ts",
      language: "typescript",
      kind: "source",
      imports: [],
      isTest: false,
      ...fileBase,
    },
    { path: "src/tests/a.test.ts", language: "typescript", kind: "test", imports: [], isTest: true, ...fileBase },
  ];
  const symbols = [
    { id: "src/infrastructure/fs/b.ts#helper", file: "src/infrastructure/fs/b.ts", name: "helper", kind: "function", exported: true },
  ];
  const edges = [
    { from: "src/interfaces/cli/a.ts", to: "src/infrastructure/fs/b.ts", type: "imports" },
    { from: "src/interfaces/cli/a.ts", to: "src/tests/a.test.ts", type: "testedBy" },
  ];
  const manifest = {
    version: codeIndexVersion,
    generated_at: "2026-08-20T00:00:00.000Z",
    project_root: ROOT,
    file_count: indexFiles.length,
    symbol_count: symbols.length,
    edge_count: edges.length,
    source_hash: sourceHash,
    // Įrašų turinio atspaudas — privalomas nuo 2026-08-23 (RAG auditas 3): be jo saugykla gali būti
    // redaguota išlaikant kiekius, ir vartas to nepamato.
    records_hash: computeRecordsHash(indexFiles as never, symbols as never, edges as never),
  };
  files.set(norm(codeIndexPath(ROOT, "manifest.json")), JSON.stringify(manifest));
  files.set(norm(codeIndexPath(ROOT, "files.jsonl")), jsonl(indexFiles));
  files.set(norm(codeIndexPath(ROOT, "symbols.jsonl")), jsonl(symbols));
  files.set(norm(codeIndexPath(ROOT, "edges.jsonl")), jsonl(edges));
  return files;
}

test("codeGraphCommand: be target'o — usage klaida ir exit 2", async () => {
  const { io, err } = captureIo();
  const exit = await codeGraphCommand({ codeFs: makeCodeFs(new Map()), projectRoot: ROOT, io }, []);
  assert.equal(exit, 2);
  assert.equal(err[0], "Usage: verqestra code-graph query <file-or-symbol> [--json] [--fuzzy]");
});

test("codeGraphCommand: failo užklausa spausdina etalono sąrašus", async () => {
  const { io, out } = captureIo();
  const deps = { codeFs: makeCodeFs(await makeIndexedFs()), projectRoot: ROOT, io };
  const exit = await codeGraphCommand(deps, ["query", "a.ts"]);
  assert.equal(exit, 0);
  assert.deepEqual(out, [
    "code-graph: a.ts",
    "matched_files: 1",
    "- src/interfaces/cli/a.ts",
    "matched_symbols: 0",
    "imports: 1",
    "- src/infrastructure/fs/b.ts",
    "importers: 0",
    "impacted_tests: 1",
    "- src/tests/a.test.ts",
  ]);
});

test("codeGraphCommand: --json grąžina pilną užklausos rezultatą", async () => {
  const { io, out } = captureIo();
  const deps = { codeFs: makeCodeFs(await makeIndexedFs()), projectRoot: ROOT, io };
  const exit = await codeGraphCommand(deps, ["query", "b.ts", "--json"]);
  assert.equal(exit, 0);
  const result = JSON.parse(out.join("\n")) as { target: string; importers: string[] };
  assert.equal(result.target, "b.ts");
  assert.deepEqual(result.importers, ["src/interfaces/cli/a.ts"]);
});

test("codeGraphCommand: --fuzzy praneša režimą ir randa simbolį pagal fragmentą", async () => {
  const { io, out } = captureIo();
  const deps = { codeFs: makeCodeFs(await makeIndexedFs()), projectRoot: ROOT, io };
  const exit = await codeGraphCommand(deps, ["query", "elper", "--fuzzy"]);
  assert.equal(exit, 0);
  assert.equal(out[1], "matching: fuzzy");
  assert.ok(out.includes("- src/infrastructure/fs/b.ts#helper"));
});

test("codeIndexCommand: check be manifesto — stale ir exit 1", async () => {
  const { io, err } = captureIo();
  const deps = { codeFs: makeCodeFs(new Map()), policyFs: makePolicyFs(new Map()), projectRoot: ROOT, io };
  const exit = await codeIndexCommand(deps, ["check"]);
  assert.equal(exit, 1);
  assert.equal(err[0], "code-index: stale (code index manifest is missing)");
});

test("codeIndexCommand: check šviežiam indeksui — fresh ir exit 0", async () => {
  const { io, out } = captureIo();
  const deps = { codeFs: makeCodeFs(await makeIndexedFs()), policyFs: makePolicyFs(new Map()), projectRoot: ROOT, io };
  const exit = await codeIndexCommand(deps, ["check"]);
  assert.equal(exit, 0);
  assert.deepEqual(out, ["code-index: fresh", "files: 3"]);
});

test("codeIndexCommand: nežinoma subkomanda — usage ir exit 2", async () => {
  const { io, err } = captureIo();
  const deps = { codeFs: makeCodeFs(new Map()), policyFs: makePolicyFs(new Map()), projectRoot: ROOT, io };
  const exit = await codeIndexCommand(deps, ["frobnicate"]);
  assert.equal(exit, 2);
  assert.equal(err[0], "Usage: verqestra code-index [build|check|architecture-check]");
});

test("codeIndexCommand: architecture-check be politikos — 0 violations", async () => {
  const { io, out } = captureIo();
  const deps = { codeFs: makeCodeFs(await makeIndexedFs()), policyFs: makePolicyFs(new Map()), projectRoot: ROOT, io };
  const exit = await codeIndexCommand(deps, ["architecture-check"]);
  assert.equal(exit, 0);
  assert.deepEqual(out, ["architecture-check: 0 violations"]);
});

test("codeIndexCommand: architecture-check randa draudžiamą importą ir grąžina 1", async () => {
  const { io, out } = captureIo();
  const policies = new Map<string, string>([
    [
      norm(path.join(ROOT, "vq", "architecture", "architecture-style.json")),
      JSON.stringify({ layers: ["interfaces", "infrastructure"], forbidden_dependencies: ["interfaces->infrastructure"] }),
    ],
  ]);
  const deps = { codeFs: makeCodeFs(await makeIndexedFs()), policyFs: makePolicyFs(policies), projectRoot: ROOT, io };
  const exit = await codeIndexCommand(deps, ["architecture-check"]);
  assert.equal(exit, 1);
  assert.deepEqual(out, [
    "architecture-check: 1 violation(s)",
    'forbidden: "src/interfaces/cli/a.ts" (interfaces) -> "src/infrastructure/fs/b.ts" (infrastructure) [interfaces->infrastructure]',
  ]);
});

function makeAssembleDeps(): AssembleContextPackDeps {
  return {
    fs: {
      readTextFileIfExists: async () => undefined,
      readFileBytes: async () => {
        throw new Error("ENOENT");
      },
      exists: async () => false,
      appendTextFile: async () => {},
      writeTextFile: async () => {},
      makeDirectory: async () => {},
    },
    codeFs: makeCodeFs(new Map()),
  };
}

test("contextPackCommand: rendina etalono tris eilutes iš assemble rezultato", async () => {
  const { io, out } = captureIo();
  const outputPath = path.join(ROOT, "vq", "supervisor", "context-pack.json");
  const fakeResult: ContextPackResult = {
    outputPath,
    pack: contextPackSchema.parse({ task_id: "0007", phase: "impl", goal: "x", allowed_paths: ["a", "b"] }),
    executionContextPath: path.join(ROOT, "vq", "supervisor", "execution-context.md"),
    executionContext: executionContextSchema.parse({
      version: 1,
      task_id: "0007",
      phase: "impl",
      goal: "x",
      fingerprint: "0123456789abcdef",
      max_chars: 1000,
      rendered_chars: 10,
    }),
  };
  const seen: string[][] = [];
  const exit = await contextPackCommand(
    {
      assembleDeps: makeAssembleDeps(),
      projectRoot: ROOT,
      io,
      assemble: async (args) => {
        seen.push(args);
        return fakeResult;
      },
    },
    ["--task", "0007"],
  );
  assert.equal(exit, 0);
  assert.deepEqual(seen, [["--task", "0007"]]);
  assert.deepEqual(out, [
    `context pack: ${path.relative(ROOT, outputPath)}`,
    "task: 0007",
    "allowed_paths: 2",
  ]);
});

test("contextPackCommand: assemble klaida — pranešimas ir exit 2", async () => {
  const { io, err } = captureIo();
  const exit = await contextPackCommand(
    {
      assembleDeps: makeAssembleDeps(),
      projectRoot: ROOT,
      io,
      assemble: async () => {
        throw new Error("task file not found");
      },
    },
    [],
  );
  assert.equal(exit, 2);
  assert.deepEqual(err, ["task file not found"]);
});
