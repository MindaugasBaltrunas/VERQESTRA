// VQ-501 (3/5-a) testai — spec CLI klasteris per fake portus: spec-drift rendinimas ir
// exit kontraktas (review-required → 1), export-api-contract (aktyvi spec → kontrakto
// juodraštis, --out, klaidos), export-json-schema (stabilus rikiavimas, --out) ir
// application eksporto taisyklės (parseEndpointLines, stableJson).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { SpecDriftPorts, SpecDriftResult } from "../application/quality-gates/spec-drift.js";
import {
  parseEndpointLines,
  type ApiContractDraft,
  type ApiContractExportPorts,
} from "../application/task-planning/api-contract-export.js";
import {
  listExportedJsonSchemaNames,
  stableJson,
} from "../application/policy-governance/json-schema-export.js";
import type { TaskPlanningFsPort } from "../application/task-planning/spec-source.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import { specDriftCommand } from "../interfaces/cli/spec/spec-drift.js";
import { exportApiContractCommand } from "../interfaces/cli/spec/export-api-contract.js";
import { exportJsonSchemaCommand } from "../interfaces/cli/spec/export-json-schema.js";
import { flagValue } from "../interfaces/cli/spec/flag-value.js";

const ROOT = path.resolve("/repo");
const norm = (p: string): string => p.replace(/\\/g, "/");

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

function makeDriftPorts(changed: string[], scope: unknown): { ports: SpecDriftPorts; results: SpecDriftResult[] } {
  const results: SpecDriftResult[] = [];
  return {
    ports: {
      assertSpecPolicy: async () => {},
      readSpecChange: async (changeId) => ({ id: changeId, scope }),
      changedFiles: async () => changed,
      writeResult: async (result) => {
        results.push(result);
      },
    },
    results,
  };
}

test("specDriftCommand: scope viduje — ok ir exit 0", async () => {
  const { io, out } = captureIo();
  const { ports, results } = makeDriftPorts(["src/a.ts"], ["src/**"]);
  const exit = await specDriftCommand({ ports, projectRoot: ROOT, io }, ["chg-1"]);
  assert.equal(exit, 0);
  assert.deepEqual(out, ["spec-drift: ok", "change: chg-1", "outside_scope: 0"]);
  assert.equal(results.length, 1);
});

test("specDriftCommand: failas už scope — review-required ir exit 1", async () => {
  const { io, out } = captureIo();
  const { ports } = makeDriftPorts(["docs/readme.md"], ["src/**"]);
  const exit = await specDriftCommand({ ports, projectRoot: ROOT, io }, ["chg-1"]);
  assert.equal(exit, 1);
  assert.deepEqual(out, ["spec-drift: review-required", "change: chg-1", "outside_scope: 1", "- docs/readme.md"]);
});

test("specDriftCommand: be change id — usage klaida ir exit 2", async () => {
  const { io, err } = captureIo();
  const { ports } = makeDriftPorts([], []);
  const exit = await specDriftCommand({ ports, projectRoot: ROOT, io }, []);
  assert.equal(exit, 2);
  assert.equal(err[0], "Usage: verqestra spec-drift <change-id> [changed-file ...]");
});

function makeContractPorts(
  files: Map<string, string>,
  dirs: Map<string, string[]>,
): { ports: ApiContractExportPorts; writes: Map<string, string> } {
  const writes = new Map<string, string>();
  const fs: TaskPlanningFsPort = {
    exists: async (p) => files.has(norm(p)),
    readTextFileIfExists: async (p) => files.get(norm(p)),
    listSubdirectories: async (d) => dirs.get(norm(d)) ?? [],
  };
  return {
    ports: {
      fs,
      writeTextFile: async (p, text) => {
        writes.set(norm(p), text);
      },
    },
    writes,
  };
}

function activeSpecFixture(proposal: string): { files: Map<string, string>; dirs: Map<string, string[]> } {
  const changeDir = path.join(ROOT, "AG", "spec", "changes", "001-api");
  const files = new Map<string, string>([
    [norm(path.join(changeDir, "spec.json")), JSON.stringify({ id: "spec-001", status: "active" })],
    [norm(path.join(changeDir, "proposal.md")), proposal],
  ]);
  const dirs = new Map<string, string[]>([[norm(path.join(ROOT, "AG", "spec", "changes")), ["001-api"]]]);
  return { files, dirs };
}

const PROPOSAL_WITH_CONTRACT = [
  "# Pasiūlymas",
  "",
  "## API Contract",
  "",
  "- GET /health — Health check",
  "- POST /tasks - Create task",
  "",
  "## Kita",
  "tekstas",
].join("\n");

test("exportApiContractCommand: aktyvi spec — kontraktas įrašomas ir exit 0", async () => {
  const { io, out } = captureIo();
  const { files, dirs } = activeSpecFixture(PROPOSAL_WITH_CONTRACT);
  const { ports, writes } = makeContractPorts(files, dirs);
  const exit = await exportApiContractCommand({ ports, projectRoot: ROOT, io }, []);
  assert.equal(exit, 0);

  const targetPath = path.join(ROOT, "vq", "generated", "api-contract.json");
  assert.deepEqual(out, [`api contract: ${path.relative(ROOT, targetPath)}`, "endpoints: 2"]);
  const written = writes.get(norm(targetPath));
  assert.ok(written);
  const contract = JSON.parse(written) as ApiContractDraft;
  assert.equal(contract.kind, "ag-api-contract-draft");
  assert.equal(contract.spec_id, "spec-001");
  assert.equal(contract.generated_from, "AG/spec/changes/001-api/spec.json");
  assert.deepEqual(contract.endpoints, [
    { method: "GET", path: "/health", summary: "Health check" },
    { method: "POST", path: "/tasks", summary: "Create task" },
  ]);
  assert.equal(contract.source_sections[0]?.source, "AG/spec/changes/001-api/proposal.md");
  assert.equal(contract.source_sections[0]?.heading, "## API Contract");
});

test("exportApiContractCommand: --out perrašo output kelią", async () => {
  const { io } = captureIo();
  const { files, dirs } = activeSpecFixture(PROPOSAL_WITH_CONTRACT);
  const { ports, writes } = makeContractPorts(files, dirs);
  const exit = await exportApiContractCommand({ ports, projectRoot: ROOT, io }, ["--out=custom/api.json"]);
  assert.equal(exit, 0);
  assert.ok(writes.has(norm(path.resolve(ROOT, "custom/api.json"))));
});

test("exportApiContractCommand: be API Contract sekcijos — klaida ir exit 2", async () => {
  const { io, err } = captureIo();
  const { files, dirs } = activeSpecFixture("# Pasiūlymas be kontrakto");
  const { ports, writes } = makeContractPorts(files, dirs);
  const exit = await exportApiContractCommand({ ports, projectRoot: ROOT, io }, []);
  assert.equal(exit, 2);
  assert.equal(err[0], "No API contract section found in active spec spec-001");
  assert.equal(writes.size, 0);
});

test("parseEndpointLines: bullet/dash variantai ir ne-endpoint eilučių ignoravimas", () => {
  const endpoints = parseEndpointLines(
    ["* PUT /users/{id}", "DELETE /users/{id} — Remove", "not an endpoint", "- FETCH /x — nevalidus metodas"].join("\n"),
  );
  assert.deepEqual(endpoints, [
    { method: "PUT", path: "/users/{id}", summary: "" },
    { method: "DELETE", path: "/users/{id}", summary: "Remove" },
  ]);
});

test("exportJsonSchemaCommand: įrašo visas schemas stabilia tvarka", async () => {
  const { io, out } = captureIo();
  const writes = new Map<string, string>();
  const ports = {
    writeTextFile: async (p: string, text: string) => {
      writes.set(norm(p), text);
    },
  };
  const exit = await exportJsonSchemaCommand({ ports, projectRoot: ROOT, io }, []);
  assert.equal(exit, 0);

  const names = listExportedJsonSchemaNames();
  assert.deepEqual(names, ["context-budget", "context-pack", "model-policy", "preflight-limits", "project-profile"]);
  assert.equal(out[0], "json schemas: vq/generated/json-schema");
  assert.deepEqual(
    out.slice(1),
    names.map((name) => `schema: vq/generated/json-schema/${name}.schema.json`),
  );
  const projectProfile = writes.get(norm(path.join(ROOT, "vq", "generated", "json-schema", "project-profile.schema.json")));
  assert.ok(projectProfile);
  // stableJson rikiuoja raktus — "$id" eina pirmas, o failas baigiasi \n.
  assert.ok(projectProfile.startsWith('{\n  "$id"'));
  assert.ok(projectProfile.endsWith("\n"));
});

test("exportJsonSchemaCommand: --out perrašo output katalogą", async () => {
  const { io, out } = captureIo();
  const writes = new Map<string, string>();
  const ports = {
    writeTextFile: async (p: string, text: string) => {
      writes.set(norm(p), text);
    },
  };
  const exit = await exportJsonSchemaCommand({ ports, projectRoot: ROOT, io }, ["--out", "schemas"]);
  assert.equal(exit, 0);
  assert.equal(out[0], "json schemas: schemas");
  assert.ok(writes.has(norm(path.join(ROOT, "schemas", "context-pack.schema.json"))));
});

test("stableJson: raktai rikiuojami rekursyviai, masyvų tvarka išlieka", () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: [3, 1] } }), '{\n  "a": {\n    "c": [\n      3,\n      1\n    ],\n    "d": 2\n  },\n  "b": 1\n}');
});

test("flagValue: inline ir atskiro argumento formos", () => {
  assert.equal(flagValue(["--out=x.json"], "--out"), "x.json");
  assert.equal(flagValue(["--out", "y.json"], "--out"), "y.json");
  assert.equal(flagValue(["--out="], "--out"), undefined);
  assert.equal(flagValue([], "--out"), undefined);
});
