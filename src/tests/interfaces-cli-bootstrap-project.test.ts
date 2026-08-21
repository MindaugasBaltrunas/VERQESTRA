// VQ-501 (5/5-e) testai — bootstrap-project srautas per fake portus: netuščia eilė sustabdo
// prieš viską, maršruto vartai sustoja PRIEŠ spec'ą ir eilę, o sėkmės kelias rašo task'us
// „nekurti, jei yra" semantika. Kiekviena užblokuota baigtis privalo palikti nulį rašymų.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { ArchitectureGraph } from "../domain/architecture/graph.js";
import type { BootstrapEligibility } from "../domain/project/index.js";
import type { ArchitectureWaveFsPort } from "../application/architecture/ports.js";
import type { BootstrapSpecPorts } from "../application/project-bootstrap/generate.js";
import type { SynthesisInput, SynthesizedTask } from "../application/architecture/task-synthesizer.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import {
  bootstrapProjectCommand,
  renderBootstrapEligibility,
  renderBootstrapProject,
  runBootstrapProject,
  type BootstrapProjectPorts,
} from "../interfaces/cli/bootstrap/bootstrap-project.js";

const ROOT = path.resolve("/repo");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

const GRAPH: ArchitectureGraph = {
  source_path: "vq/architecture/source/app.mmd",
  imported_at: "2026-08-21T00:00:00.000Z",
  nodes: [
    { id: "core", label: "Core", kind: "component", status: "planned" },
    { id: "api", label: "API", kind: "component", status: "planned" },
  ],
  edges: [{ from: "core", to: "api", type: "depends_on" }],
};

const ELIGIBLE: BootstrapEligibility = {
  bucketsEmpty: true,
  hasReadme: true,
  mmdSources: ["vq/architecture/source/app.mmd"],
  bootstrapEligible: true,
};

const EVIDENCE_LINES = [
  { node_id: "core", source: "README.md", excerpt: "Core.", timestamp: "2026-08-21T00:00:00.000Z" },
  { node_id: "api", source: "README.md", excerpt: "API.", timestamp: "2026-08-21T00:00:00.000Z" },
]
  .map((entry) => JSON.stringify(entry))
  .join("\n");

function fakeSynthesize(input: SynthesisInput): SynthesizedTask {
  return {
    run_id: input.runId,
    node_id: input.nodeId,
    node_label: input.nodeId,
    evidence_count: input.evidence.length,
    allowed_files: [`src/${input.nodeId}.ts`],
    markdown: `# ${input.runId}\n`,
  };
}

type World = {
  ports: BootstrapProjectPorts;
  written: Map<string, string>;
  stateWrites: string[];
};

function world(
  input: {
    detection?: BootstrapEligibility;
    graph?: ArchitectureGraph | null;
    files?: Record<string, string>;
    intentStack?: { language?: string; framework?: string; architectureStyle?: string };
    generateChange?: BootstrapSpecPorts["generateChange"];
    existingQueueTasks?: string[];
  } = {},
): World {
  const files = { ...(input.files ?? {}) };
  const written = new Map<string, string>();
  const stateWrites: string[] = [];
  const existingQueue = new Set(input.existingQueueTasks ?? []);

  const fs: ArchitectureWaveFsPort = {
    exists: async (p) => files[rel(p)] !== undefined,
    readTextFileIfExists: async (p) => files[rel(p)],
    appendTextFile: async () => {},
    writeTextFile: async (p, text) => {
      stateWrites.push(rel(p));
      files[rel(p)] = text;
    },
    removeFile: async () => {},
    listFiles: async () => [],
    listDirectory: async () => [],
  };

  const spec: BootstrapSpecPorts = {
    loadReadmeProductIntent: async () => ({
      kind: "intent",
      title: "Demo",
      sections: [{ heading: "Goal", level: 2, bullets: ["Build it."], paragraphs: [] }],
    }),
    refreshArchitectureFromSource: async () => {},
    readArchitectureGraph: async () => (input.graph === undefined ? GRAPH : input.graph),
    generateChange: input.generateChange ?? (async () => "auto-demo"),
    listMarkdownFiles: async () => [`${ROOT}/AG/openspec/changes/auto-demo/proposal.md`],
  };

  return {
    written,
    stateWrites,
    ports: {
      spec,
      fs,
      updateNodeProgress: async () => {},
      nowIso: () => "2026-08-21T00:00:00.000Z",
      detectEligibility: async () => input.detection ?? ELIGIBLE,
      // Numatytai PILNAI eksplicitinis README stack pasirinkimas: jis autoritetingas
      // deriveStackDecision viduje, tad srauto testai nepriklauso nuo to, kokį confidence
      // dviejų mazgų grafas atsitiktinai duotų.
      extractExplicitStackChoice: () =>
        input.intentStack ?? { language: "typescript", framework: "node", architectureStyle: "layered" },
      resolveModel: async (tier) => `claude-${tier}-5`,
      writeQueueTaskIfMissing: async (p, markdown) => {
        const key = rel(p);
        if (existingQueue.has(path.basename(key))) return false;
        written.set(key, markdown);
        return true;
      },
      synthesize: fakeSynthesize,
    },
  };
}

const GRAPH_PATH = "vq/state/architecture/graph.json";
const EVIDENCE_PATH = "vq/state/architecture/evidence.jsonl";

test("renderBootstrapEligibility: keturios eilutės su yes/no ir šaltinių skaičiumi", () => {
  assert.equal(
    renderBootstrapEligibility(ELIGIBLE),
    ["Bootstrap eligible: yes", "Buckets empty: yes", "README present: yes", "Mermaid sources: 1"].join("\n"),
  );
});

test("runBootstrapProject: netuščia eilė sustabdo prieš viską — jokių rašymų", async () => {
  const busy = world({ detection: { ...ELIGIBLE, bucketsEmpty: false, bootstrapEligible: false } });
  const result = await runBootstrapProject({ ports: busy.ports, projectRoot: ROOT });

  assert.equal(result.status, "skipped-nonempty");
  assert.equal(busy.written.size, 0);
  assert.equal(busy.stateWrites.length, 0, "net stack sprendimas dar nerašomas");
  assert.match(renderBootstrapProject(result), /^Bootstrap skipped: /);
});

test("runBootstrapProject: trūkstamas .mmd šaltinis maršrutizuoja į human-review prieš spec'ą", async () => {
  let specCalls = 0;
  const blocked = world({ detection: { ...ELIGIBLE, mmdSources: [], bootstrapEligible: false }, graph: null });
  blocked.ports.spec.generateChange = async () => {
    specCalls += 1;
    return "auto-demo";
  };

  const result = await runBootstrapProject({ ports: blocked.ports, projectRoot: ROOT });
  assert.equal(result.status, "human-review");
  assert.match(result.status === "human-review" ? result.reason : "", /no Mermaid/);
  assert.equal(specCalls, 0, "spec generatorius nekviečiamas užblokuotame kelyje");
  assert.equal(blocked.written.size, 0);
});

test("runBootstrapProject: sėkmė — spec + eilės task'ai, esamas failas praleidžiamas", async () => {
  const ready = world({
    files: { [GRAPH_PATH]: JSON.stringify(GRAPH), [EVIDENCE_PATH]: EVIDENCE_LINES },
    existingQueueTasks: ["auto-demo-002-api.md"],
  });
  const result = await runBootstrapProject({ ports: ready.ports, projectRoot: ROOT });

  assert.equal(result.status, "generated");
  if (result.status !== "generated") return;
  assert.equal(result.changeId, "auto-demo");
  assert.deepEqual(result.created, ["AG/tasks/queue/auto-demo-001-core.md"]);
  assert.deepEqual(result.skipped, ["AG/tasks/queue/auto-demo-002-api.md"]);
  assert.equal(ready.written.size, 1, "jau gulintis task'as neperrašomas");

  const rendered = renderBootstrapProject(result);
  assert.match(rendered, /^Bootstrap generated OpenSpec change: /m);
  assert.match(rendered, /queue tasks created: 1/);
  assert.match(rendered, /queue tasks skipped: 1/);
});

test("runBootstrapProject: be įrodymų eilės sintezė sustoja ir nerašo nieko", async () => {
  const noEvidence = world({ files: { [GRAPH_PATH]: JSON.stringify(GRAPH) } });
  const result = await runBootstrapProject({ ports: noEvidence.ports, projectRoot: ROOT });

  assert.equal(result.status, "insufficient-evidence");
  if (result.status !== "insufficient-evidence") return;
  assert.equal(result.stage, "queue");
  assert.deepEqual(
    result.weakEvidence.map((weak) => weak.nodeId),
    ["core", "api"],
  );
  assert.equal(noEvidence.written.size, 0);
  assert.match(renderBootstrapProject(result), /- weak evidence: core \(Core\)/);
});

test("runBootstrapProject: generatorius be naudingo change — generation-failed, be eilės", async () => {
  const failing = world({
    files: { [GRAPH_PATH]: JSON.stringify(GRAPH), [EVIDENCE_PATH]: EVIDENCE_LINES },
    generateChange: async () => null,
  });
  const result = await runBootstrapProject({ ports: failing.ports, projectRoot: ROOT });

  assert.equal(result.status, "generation-failed");
  assert.equal(failing.written.size, 0);
  assert.match(renderBootstrapProject(result), /generation failed/);
});

test("bootstrapProjectCommand: generated → 0, human-review → 1, blogas argumentas → 2", async () => {
  const ready = world({ files: { [GRAPH_PATH]: JSON.stringify(GRAPH), [EVIDENCE_PATH]: EVIDENCE_LINES } });
  const ok = captureIo();
  assert.equal(await bootstrapProjectCommand({ ports: ready.ports, projectRoot: ROOT, io: ok.io }, []), 0);
  assert.match(ok.out[0] ?? "", /^Bootstrap generated OpenSpec change: /);

  const jsonRun = world({ files: { [GRAPH_PATH]: JSON.stringify(GRAPH), [EVIDENCE_PATH]: EVIDENCE_LINES } });
  const json = captureIo();
  assert.equal(
    await bootstrapProjectCommand({ ports: jsonRun.ports, projectRoot: ROOT, io: json.io }, ["--json"]),
    0,
  );
  assert.equal((JSON.parse(json.out.join("\n")) as { status: string }).status, "generated");

  const blocked = world({ detection: { ...ELIGIBLE, mmdSources: [], bootstrapEligible: false }, graph: null });
  const review = captureIo();
  assert.equal(await bootstrapProjectCommand({ ports: blocked.ports, projectRoot: ROOT, io: review.io }, []), 1);
  assert.match(review.out[0] ?? "", /^Bootstrap routed to human review: /);

  const bad = captureIo();
  assert.equal(await bootstrapProjectCommand({ ports: ready.ports, projectRoot: ROOT, io: bad.io }, ["--force"]), 2);
  assert.equal(bad.err[0], "Unknown bootstrap-project argument: --force");
});
