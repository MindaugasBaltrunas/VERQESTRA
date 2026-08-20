// Project bootstrap testai (VQ-305 3/3-g): profilio detekcija per portus ir OpenSpec
// change generavimas su įrodymų disciplina (be LLM — generatorius stub'as, kaip etalone).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  detectProjectProfile,
  detectProjectProfileEvidence,
  type ProfileDetectionPorts,
} from "../application/project-bootstrap/detect-profile.js";
import {
  generateProjectImplementationSpec,
  type BootstrapSpecPorts,
  type ProductIntentResult,
} from "../application/project-bootstrap/generate.js";

const ROOT = path.resolve("/repo");
const norm = (p: string): string => p.replace(/\\/g, "/");

function detectionPorts(input: {
  existing?: string[];
  markers?: string[];
  sourceFiles?: string[];
}): ProfileDetectionPorts {
  const existing = new Set((input.existing ?? []).map((rel) => norm(path.join(ROOT, rel))));
  return {
    exists: async (p) => existing.has(norm(p)),
    findProductMarkers: async () => input.markers ?? [],
    findSourceFiles: async () => input.sourceFiles ?? [],
  };
}

test("profilio įrodymai: dominuojantis plėtinys, lockfile ir realūs source roots", async () => {
  const ports = detectionPorts({
    existing: ["pnpm-lock.yaml", "src"],
    markers: ["package.json"],
    sourceFiles: ["a.ts", "b.ts", "c.py"],
  });
  const evidence = await detectProjectProfileEvidence(ports, "/repo");
  assert.equal(evidence.language, "typescript");
  assert.equal(evidence.packageManager, "pnpm");
  assert.deepEqual(evidence.sourceRoots, ["src"]);

  const profile = await detectProjectProfile(ports, "/repo", { language: "go" });
  assert.equal(profile.language.value, "go");
  assert.equal(profile.language.source, "explicit");
});

test("be source failų kalbos užuomina ateina iš paties marker'io", async () => {
  const evidence = await detectProjectProfileEvidence(detectionPorts({ markers: ["go.mod"] }), "/repo");
  assert.equal(evidence.language, "go");
});

const INTENT: ProductIntentResult = {
  kind: "intent",
  title: "Mano produktas",
  sections: [
    { heading: "Mano produktas", level: 1, bullets: ["pirmas punktas"], paragraphs: [] },
    { heading: "Funkcijos", level: 2, bullets: ["antra funkcija"], paragraphs: ["pastraipa"] },
  ],
};

function bootstrapPorts(overrides: Partial<BootstrapSpecPorts> = {}): BootstrapSpecPorts & { taskTexts: string[] } {
  const taskTexts: string[] = [];
  return {
    taskTexts,
    loadReadmeProductIntent: async () => INTENT,
    refreshArchitectureFromSource: async () => {},
    readArchitectureGraph: async () => ({
      source_path: "architecture.mmd",
      imported_at: "2026-08-20T00:00:00.000Z",
      nodes: [{ id: "core", label: "Core", kind: "component" as const, status: "planned" as const }],
      edges: [{ from: "core", to: "core", type: "depends_on" as const }],
    }),
    generateChange: async (taskText) => {
      taskTexts.push(taskText);
      return "openspec/changes/auto-mano-produktas";
    },
    listMarkdownFiles: async (dir) => [path.join(dir, "proposal.md"), path.join(dir, "tasks.md")],
    ...overrides,
  };
}

test("insufficient-evidence: README be intencijos nefabrikuoja spec'o", async () => {
  const missing = await generateProjectImplementationSpec(
    bootstrapPorts({ loadReadmeProductIntent: async () => ({ kind: "no-intent", reason: "readme-missing" }) }),
    "/repo",
    path.join(ROOT, "AG"),
    "sonnet",
  );
  assert.deepEqual(missing, {
    status: "insufficient-evidence",
    reason: "README.md is missing — no product intent to bootstrap from.",
  });

  const empty = await generateProjectImplementationSpec(
    bootstrapPorts({
      loadReadmeProductIntent: async () => ({ kind: "intent", sections: [{ level: 1, bullets: [], paragraphs: [] }] }),
    }),
    "/repo",
    path.join(ROOT, "AG"),
    "sonnet",
  );
  assert.equal(empty.status, "insufficient-evidence");
});

test("generation-failed: generatoriui grąžinus null spec'as neišgalvojamas", async () => {
  const result = await generateProjectImplementationSpec(
    bootstrapPorts({ generateChange: async () => null }),
    "/repo",
    path.join(ROOT, "AG"),
    "sonnet",
  );
  assert.equal(result.status, "generation-failed");
});

test("generated: task tekstas sukomponuotas TIK iš README ir grafo, failai — project-relative", async () => {
  const ports = bootstrapPorts();
  const result = await generateProjectImplementationSpec(ports, "/repo", path.join(ROOT, "AG"), "sonnet");
  assert.equal(result.status, "generated");
  if (result.status !== "generated") return;
  assert.equal(result.changeId, "auto-mano-produktas");
  assert.deepEqual(result.files, [
    "AG/openspec/changes/auto-mano-produktas/proposal.md",
    "AG/openspec/changes/auto-mano-produktas/tasks.md",
  ]);

  const taskText = ports.taskTexts[0]!;
  assert.match(taskText, /# Project Implementation: Mano produktas/);
  assert.match(taskText, /- pirmas punktas/);
  assert.match(taskText, /### Funkcijos/);
  assert.match(taskText, /- core: Core/);
});
