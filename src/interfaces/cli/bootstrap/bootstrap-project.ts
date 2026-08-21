// `bootstrap-project` CLI adapteris (etalonas: interfaces/cli/bootstrap-project/index.ts):
// tuščios eilės bootstrap srautas nuo galo iki galo — tinkamumas → architektūros importas →
// maršruto vartai → OpenSpec change → eilės sintezė → task failų rašymas.
//
// Komanda TIK PARUOŠIA: preflight, dispatch ir final-audit lieka nepaliesti. Kiekviena
// ne-`generated` baigtis reiškia, kad NEĮRAŠYTA nė vieno eilės failo — užblokuotame kelyje
// sustojama prieš rašymą, o ne po jo.
//
// Vienintelis rašymas į eilę vyksta su „nekurti, jei yra" semantika: jau gulintis to paties
// vardo task'as niekada neperrašomas, tad pakartotinis paleidimas nepraranda darbo.

import path from "node:path";
import {
  deriveStackDecision,
  evaluateBootstrapRouting,
  type ExplicitStackChoice,
} from "../../../domain/policies/index.js";
import type { BootstrapEligibility } from "../../../domain/project/index.js";
import { classifyInputSourceNodes } from "../../../domain/architecture/input-source-classification.js";
import { extractStackSignals } from "../../../application/code-intelligence/graph-source/stack-signal-extraction.js";
import {
  architectureStateDir,
  readProgressSafe,
} from "../../../application/architecture/wave-reclaim.js";
import { markAlreadyImplementedNodes } from "../../../application/architecture/wave.js";
import { persistStackDecisionState } from "../../../application/architecture/governance.js";
import type { ArchitectureWaveFsPort, ArchitectureWavePorts } from "../../../application/architecture/ports.js";
import {
  generateProjectImplementationSpec,
  type BootstrapSpecPorts,
  type ProductIntent,
} from "../../../application/project-bootstrap/generate.js";
import {
  generateBootstrapQueueTasks,
  type QueueTask,
  type TaskSynthesizer,
  type WeakEvidenceSignal,
} from "../../../application/project-bootstrap/queue-synth.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type BootstrapProjectPorts = {
  /** OpenSpec autorystės portai; iš jų imamas ir README intentas, ir grafo skaitymas/atnaujinimas. */
  spec: BootstrapSpecPorts;
  fs: ArchitectureWaveFsPort;
  updateNodeProgress: ArchitectureWavePorts["updateNodeProgress"];
  nowIso?: () => string;
  /** Tinkamumo detekcija: bucket'ai, README, `.mmd` šaltiniai. */
  detectEligibility(projectRoot: string): Promise<BootstrapEligibility>;
  /** Eksplicitinis stack pasirinkimas iš README `## Stack` sekcijos. */
  extractExplicitStackChoice(intent: ProductIntent): ExplicitStackChoice | undefined;
  /** Pakopa → realus modelio ID OpenSpec autoriui. */
  resolveModel(tier: string): Promise<string>;
  /** `wx` rašymas: `true` — failas sukurtas, `false` — jau egzistavo (niekada neperrašo). */
  writeQueueTaskIfMissing(absolutePath: string, markdown: string): Promise<boolean>;
  /** Injektuojamas per-mazgo sintezatorius (testams); numatytai — realus renderis. */
  synthesize?: TaskSynthesizer;
};

export type BootstrapProjectDeps = {
  ports: BootstrapProjectPorts;
  projectRoot: string;
  io?: CliIo;
};

export type BootstrapProjectResult =
  /** Bent vienas bucket'as netuščias: bootstrap veikia tik ant visiškai tuščios eilės. */
  | { status: "skipped-nonempty"; reason: string; detection: BootstrapEligibility }
  /** Maršrutas atiduotas žmogui (trūkstami/prieštaringi įrodymai ar rizikingas stack sprendimas). */
  | { status: "human-review"; reason: string }
  /** Nepavyko importuoti jokio grafo — nėra iš ko sintezuoti. */
  | { status: "no-architecture"; reason: string; stage: "openspec" | "queue" }
  /** README/grafo įrodymų per mažai spec'ui ar bent vienam task'ui (įrodymų disciplina). */
  | { status: "insufficient-evidence"; reason: string; stage: "openspec" | "queue"; weakEvidence: WeakEvidenceSignal[] }
  /** Generatorius pasileido, bet naudingo change nepagamino; spec'as neišgalvojamas. */
  | { status: "generation-failed"; reason: string; stage: "openspec" }
  | {
      status: "generated";
      changeId: string;
      changeRef: string;
      specFiles: string[];
      created: string[];
      skipped: string[];
      tasks: QueueTask[];
      weakEvidence: WeakEvidenceSignal[];
    };

/** Tinkamumo santrauka žmogui (WBR VQ-204: pateikimo forma priklauso interfaces, ne domain). */
export function renderBootstrapEligibility(result: BootstrapEligibility): string {
  return [
    `Bootstrap eligible: ${result.bootstrapEligible ? "yes" : "no"}`,
    `Buckets empty: ${result.bucketsEmpty ? "yes" : "no"}`,
    `README present: ${result.hasReadme ? "yes" : "no"}`,
    `Mermaid sources: ${result.mmdSources.length}`,
  ].join("\n");
}

/**
 * Jau įgyvendinti mazgai pažymimi `done` PRIEŠ eilės sintezę (ta pati detekcija kaip wave):
 * kilpa niekada neturi imti mazgo, kurio implementacija repo jau egzistuoja — kitaip bootstrap
 * jam sugeneruotų task'ą ir Claude sesija būtų iššvaistyta ALREADY_IMPLEMENTED patikrai.
 */
async function markImplementedBeforeSynthesis(
  ports: BootstrapProjectPorts,
  root: string,
  graph: Awaited<ReturnType<BootstrapSpecPorts["readArchitectureGraph"]>>,
): Promise<void> {
  if (!graph) return;
  const progressPath = path.join(architectureStateDir(root), "progress.json");
  const progress = await readProgressSafe(ports.fs, progressPath);
  if (!progress) return;

  const wavePorts: ArchitectureWavePorts = {
    fs: ports.fs,
    updateNodeProgress: ports.updateNodeProgress,
    ...(ports.nowIso === undefined ? {} : { nowIso: ports.nowIso }),
  };
  await markAlreadyImplementedNodes(wavePorts, root, classifyInputSourceNodes(graph), progress, progressPath);
}

export async function runBootstrapProject(deps: BootstrapProjectDeps): Promise<BootstrapProjectResult> {
  const ports = deps.ports;
  const root = path.resolve(deps.projectRoot);
  const agRoot = path.join(root, "AG");

  // 1. Tinkamumas: bootstrap skirtas TIK projektui, kurio visi task bucket'ai tušti.
  const detection = await ports.detectEligibility(root);
  if (!detection.bucketsEmpty) {
    return {
      status: "skipped-nonempty",
      reason: "One or more AG task buckets are non-empty; bootstrap only runs on an empty queue.",
      detection,
    };
  }

  // 2. Grafo importas/atnaujinimas iš `.mmd` šaltinių (idempotentiškas).
  await ports.spec.refreshArchitectureFromSource(root);
  const graph = await ports.spec.readArchitectureGraph(path.join(architectureStateDir(root), "graph.json"));
  await markImplementedBeforeSynthesis(ports, root, graph);

  // 3. Maršruto vartai. Stack pasitikėjimas išvedamas deterministiškai iš importuoto grafo ir
  //    sulydomas su eksplicitiniu README pasirinkimu.
  const intentResult = await ports.spec.loadReadmeProductIntent(root);
  const explicitStackChoice =
    intentResult.kind === "intent" ? ports.extractExplicitStackChoice(intentResult) : undefined;
  const stackDecision = deriveStackDecision(
    extractStackSignals(graph ?? { source_path: "", imported_at: "", nodes: [], edges: [] }),
    explicitStackChoice,
  );

  // Sprendimas persistinamas PRIEŠ vartus: ir human-review atveju žmogus turi matyti, KAS buvo
  // nuspręsta ir kodėl. Be signalų priimtas sprendimas viduje praleidžiamas, tad tuščias grafas
  // nieko nerašo.
  await persistStackDecisionState(ports.fs, stackDecision, root);

  // Pilnai eksplicitinis pasirinkimas (kalba + framework + stilius) yra autoritetas pačiame
  // deriveStackDecision, tad ta pati sąlyga atkartojama ir čia — žemo confidence trigeris jam
  // netaikomas.
  const explicitStackChoiceProvided =
    explicitStackChoice !== undefined &&
    explicitStackChoice.language !== undefined &&
    explicitStackChoice.framework !== undefined &&
    typeof explicitStackChoice.architectureStyle === "string" &&
    explicitStackChoice.architectureStyle.trim().length > 0;

  const routing = evaluateBootstrapRouting(
    {
      hasReadme: detection.hasReadme,
      mmdSourceCount: detection.mmdSources.length,
      // Deterministinio README↔.mmd konflikto detektoriaus čia nėra; tai NE tas pats, kas
      // eksplicitinio ir išvestinio stack'o konfliktas, kurį jau neša humanReviewRequired.
      readmeMmdConflict: false,
    },
    {
      confidence: stackDecision.confidence,
      explicitStackChoiceProvided,
      humanReviewRequired: stackDecision.humanReviewRequired,
    },
  );
  if (routing.route === "human-review") {
    return { status: "human-review", reason: routing.reason };
  }

  // 4. OpenSpec change iš README intencijos + grafo.
  const model = await ports.resolveModel("sonnet");
  const spec = await generateProjectImplementationSpec(ports.spec, root, agRoot, model);
  if (spec.status === "insufficient-evidence") {
    return { status: "insufficient-evidence", reason: spec.reason, stage: "openspec", weakEvidence: [] };
  }
  if (spec.status === "generation-failed") {
    return { status: "generation-failed", reason: spec.reason, stage: "openspec" };
  }

  // 5. Pirmieji žingsnis-po-žingsnio eilės task'ai iš change'o + grafo įrodymų.
  const queue = await generateBootstrapQueueTasks(
    { fs: ports.fs, ...(ports.synthesize === undefined ? {} : { synthesize: ports.synthesize }) },
    root,
    spec.changeId,
  );
  if (queue.status === "no-architecture") {
    return { status: "no-architecture", reason: queue.reason, stage: "queue" };
  }
  if (queue.status === "insufficient-evidence") {
    return { status: "insufficient-evidence", reason: queue.reason, stage: "queue", weakEvidence: queue.weakEvidence };
  }

  // 6. Rašymas. Esamas to paties vardo failas niekada neperrašomas.
  const created: string[] = [];
  const skipped: string[] = [];
  for (const task of queue.tasks) {
    const filePath = path.join(agRoot, "tasks", "queue", `${task.taskId}.md`);
    const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
    if (await ports.writeQueueTaskIfMissing(filePath, task.markdown)) created.push(relativePath);
    else skipped.push(relativePath);
  }

  return {
    status: "generated",
    changeId: spec.changeId,
    changeRef: spec.changeRef,
    specFiles: spec.files,
    created,
    skipped,
    tasks: queue.tasks,
    weakEvidence: queue.weakEvidence,
  };
}

export function renderBootstrapProject(result: BootstrapProjectResult): string {
  switch (result.status) {
    case "skipped-nonempty":
      return [`Bootstrap skipped: ${result.reason}`, renderBootstrapEligibility(result.detection)].join("\n");
    case "human-review":
      return `Bootstrap routed to human review: ${result.reason}`;
    case "no-architecture":
      return `Bootstrap stopped (${result.stage}): ${result.reason}`;
    case "insufficient-evidence":
      return [
        `Bootstrap stopped (${result.stage}, insufficient evidence): ${result.reason}`,
        ...result.weakEvidence.map((weak) => `- weak evidence: ${weak.nodeId} (${weak.nodeLabel})`),
      ].join("\n");
    case "generation-failed":
      return `Bootstrap stopped (${result.stage}, generation failed): ${result.reason}`;
    case "generated": {
      const lines = [
        `Bootstrap generated OpenSpec change: ${result.changeRef}`,
        `queue tasks created: ${result.created.length}`,
        `queue tasks skipped: ${result.skipped.length}`,
      ];
      for (const file of result.created) lines.push(`created: ${file}`);
      for (const file of result.skipped) lines.push(`skipped: ${file}`);
      for (const weak of result.weakEvidence) lines.push(`weak evidence: ${weak.nodeId} (${weak.nodeLabel})`);
      return lines.join("\n");
    }
  }
}

export async function bootstrapProjectCommand(deps: BootstrapProjectDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const unknown = args.filter((arg) => arg !== "--json");
    if (unknown.length > 0) throw new Error(`Unknown bootstrap-project argument: ${unknown[0]}`);

    const result = await runBootstrapProject(deps);
    io.out(args.includes("--json") ? JSON.stringify(result, null, 2) : renderBootstrapProject(result));
    // Tuščia eilė yra laukiama baigtis, ne gedimas; visos kitos ne-`generated` baigtys reikalauja
    // dėmesio, tad grąžina 1.
    return result.status === "generated" || result.status === "skipped-nonempty" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
