// VQ-301 characterization (PAR-1): CodeIndex užklausų runner'is prieš pažodinę AG_loop
// fixture kopiją. Workspace materializuojamas VERBATIM į tmpdir; buildCodeIndex gauna
// testo fs-backed porto adapterį (produkcinis adapteris — E4). Record režimo NĖRA.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { analyzeImpact } from "../application/code-intelligence/query/impact.js";
import { queryCodeGraphData } from "../application/code-intelligence/query/query.js";
import { selectSemanticCodeContext } from "../application/code-intelligence/query/semantic-context.js";
import { codeIndexPath, readCodeIndex } from "../application/code-intelligence/store/code-index-store.js";
import type { CodeIndexData } from "../application/code-intelligence/indexing/types.js";
import {
  findArchitectureBoundaryViolations,
  type ArchitectureBoundaryPolicyView,
} from "../application/code-intelligence/boundary/architecture-boundary.js";

type CharacterizationCase = {
  id: string;
  kind: "graph" | "impact" | "semantic" | "boundary";
  target?: string;
  targets?: string[];
  options?: { fuzzy?: boolean };
  limits?: { maxSymbols: number; maxContractSymbols?: number };
  policy?: Record<string, unknown>;
  expect: Record<string, unknown>;
};

type CodeIndexFixture = {
  schema_version: number;
  record?: boolean;
  workspace: { files: Record<string, string> };
  expected_manifest: Record<string, unknown>;
  expected_storage: {
    files: string[];
    key_order: Record<string, string[]>;
  };
  cases: CharacterizationCase[];
};

const fixturePath = path.resolve(
  process.cwd(),
  "src",
  "tests",
  "fixtures",
  "characterization",
  "code-index-queries.json",
);

const fixture: CodeIndexFixture = JSON.parse(await readFile(fixturePath, "utf8"));

let workspaceRoot = "";
let index: CodeIndexData;

before(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "vq-301-"));
  for (const [relative, content] of Object.entries(fixture.workspace.files)) {
    const absolute = path.join(workspaceRoot, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  index = await buildCodeIndex(nodeFsTestPort, workspaceRoot);
});

after(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function runCase(characterizationCase: CharacterizationCase): unknown {
  switch (characterizationCase.kind) {
    case "graph": {
      const result = queryCodeGraphData(index, characterizationCase.target ?? "", characterizationCase.options ?? {});
      return {
        ...result,
        matched_files: result.matched_files.map((file) => file.path),
        matched_symbols: result.matched_symbols.map((symbol) => symbol.id),
      };
    }
    case "impact":
      return analyzeImpact(index, characterizationCase.targets ?? []);
    case "semantic": {
      const result = selectSemanticCodeContext(index, characterizationCase.targets ?? [], {
        maxSymbols: characterizationCase.limits?.maxSymbols ?? 5,
        ...(characterizationCase.limits?.maxContractSymbols === undefined
          ? {}
          : { maxContractSymbols: characterizationCase.limits.maxContractSymbols }),
      });
      return {
        ...result,
        symbols: result.symbols.map((symbol) => ({
          id: symbol.id,
          name: symbol.name,
          line: symbol.line,
          endLine: symbol.endLine,
          exported: symbol.exported,
          reason: symbol.reason,
          role: symbol.role,
        })),
      };
    }
    case "boundary": {
      // Fixture policy tenkina domain view struktūriškai — zod schema atsiras prie
      // policy IO modulio (VQ-305); boundary patikrai užtenka view laukų.
      const policy = characterizationCase.policy as unknown as ArchitectureBoundaryPolicyView;
      return { violations: findArchitectureBoundaryViolations(index, policy) };
    }
    default:
      throw new Error(`fixture names unknown case kind: ${characterizationCase.kind}`);
  }
}

function normalizedManifest(): Record<string, unknown> {
  const manifest: Record<string, unknown> = { ...(index.manifest as unknown as Record<string, unknown>) };
  delete manifest["generated_at"];
  delete manifest["project_root"];
  return manifest;
}

test("code-index characterization fixture is well-formed (schema v1, unique ids)", () => {
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length >= 9, "fixture must keep its recorded coverage");
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
});

// E4 byte-compat kontraktas: JSONL be \r, su trailing \n, eilučių skaičius = manifest count,
// raktų tvarka — užfiksuoto key_order PREFIKSAS (optional laukai gali trūkti, tvarka nekinta).
test("code-index storage keeps the JSONL byte contract", async () => {
  const countByFile: Record<string, number> = {
    "files.jsonl": index.manifest.file_count,
    "symbols.jsonl": index.manifest.symbol_count,
    "edges.jsonl": index.manifest.edge_count,
  };
  const keyOrderByFile: Record<string, string[]> = {
    "files.jsonl": fixture.expected_storage.key_order["file"] ?? [],
    "symbols.jsonl": fixture.expected_storage.key_order["symbol"] ?? [],
    "edges.jsonl": fixture.expected_storage.key_order["edge"] ?? [],
  };
  for (const fileName of ["files.jsonl", "symbols.jsonl", "edges.jsonl"]) {
    const raw = await readFile(codeIndexPath(workspaceRoot, fileName), "utf8");
    assert.ok(!raw.includes("\r"), `${fileName}: CRLF is a byte-contract break`);
    assert.ok(raw.endsWith("\n"), `${fileName}: trailing newline is part of the contract`);
    const lines = raw.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, countByFile[fileName], `${fileName}: line count != manifest count`);
    const expectedOrder = keyOrderByFile[fileName] ?? [];
    for (const line of lines) {
      const keys = Object.keys(JSON.parse(line) as Record<string, unknown>);
      const prefix = expectedOrder.filter((key) => keys.includes(key));
      assert.deepEqual(keys, prefix, `${fileName}: key order drifted for line ${line.slice(0, 80)}`);
    }
  }
  const manifestRaw = await readFile(codeIndexPath(workspaceRoot, "manifest.json"), "utf8");
  assert.equal(manifestRaw, `${JSON.stringify(JSON.parse(manifestRaw), null, 2)}\n`, "manifest.json indent contract");
});

test("code-index round-trips through the store and rebuilds deterministically", async () => {
  const readBack = await readCodeIndex(nodeFsTestPort, workspaceRoot);
  assert.ok(readBack, "readCodeIndex must return the just-written index");
  assert.deepEqual(
    JSON.parse(JSON.stringify({ files: readBack.files, symbols: readBack.symbols, edges: readBack.edges })),
    JSON.parse(JSON.stringify({ files: index.files, symbols: index.symbols, edges: index.edges })),
  );
  const rebuilt = await buildCodeIndex(nodeFsTestPort, workspaceRoot);
  assert.equal(
    JSON.stringify({ files: rebuilt.files, symbols: rebuilt.symbols, edges: rebuilt.edges }),
    JSON.stringify({ files: index.files, symbols: index.symbols, edges: index.edges }),
    "two consecutive builds must be byte-identical",
  );
});

test("code-index manifest matches the recorded etalon", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(normalizedManifest())), fixture.expected_manifest);
});

for (const characterizationCase of fixture.cases) {
  test(`code-index contract: ${characterizationCase.id}`, () => {
    const actual = JSON.parse(JSON.stringify(runCase(characterizationCase) ?? null));
    assert.deepStrictEqual(actual, characterizationCase.expect, characterizationCase.id);
  });
}
