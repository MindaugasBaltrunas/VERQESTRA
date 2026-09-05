// Architektūros mazgo task'o sintezė (etalonas: AG_loop architecture/
// architecture-task-synthesizer.ts 1:1, WBR VQ-501 3/5-c). synthesizeTask — GRYNAS
// markdown renderis (agentų grandinė — domain serializeAgentChain, FQC-12);
// writeSynthesisOutput — vienas rašymas per portą į `vq/state/architecture/task-synthesis`
// (kelią paduoda kvietėjas).

import path from "node:path";
import { serializeAgentChain } from "../../domain/policies/agent-selection.js";
import type {
  ArchitectureGraph,
  ArchitectureProgress,
  NodeInterfaceContract,
} from "../../domain/architecture/graph.js";
import type { EvidenceEntry } from "../../domain/architecture/evidence.js";
import type { StackDecision } from "../../domain/policies/stack-decision.js";
import type { ArchitectureStateFsPort } from "./ports.js";

export type SynthesisInput = {
  nodeId: string;
  graph: ArchitectureGraph;
  progress: ArchitectureProgress;
  evidence: EvidenceEntry[];
  contract: NodeInterfaceContract;
  runId: string;
  /**
   * Kanoninė OpenSpec change nuoroda (`openspec/changes/<change-id>`), kai sintezė
   * kyla iš OpenSpec change (bootstrap flow). Be jos `## Spec source` turi tik
   * `architecture-node/<id>` eilutę, kurios preflight NEatpažįsta kaip aktyvios
   * OpenSpec nuorodos — source-change task'as su `autoOpenSpec=false` keliauja
   * tiesiai į human-review dar prieš dispatch. Su ja preflight praleidžia, o
   * `architecture-node/` eilutė lieka traceability tikslams.
   */
  specSource?: string;
  /**
   * Persisted project-wide StackDecision (governance loadStackDecisionState), jei yra.
   * Kai yra, pasirinkta kalba/framework/architektūros stilius rendinami `## Stack`
   * sekcijoje, kad vykdantis agentas sektų pasirinktą stack'ą, o ne spėliotų per task'ą.
   */
  stackDecision?: StackDecision;
};

export type SynthesizedTask = {
  run_id: string;
  node_id: string;
  node_label: string;
  evidence_count: number;
  allowed_files: string[];
  markdown: string;
};

/** Testo failo forma etalono ## Failai (2) prasme (`*.test.ts`, `*.spec.tsx`, `src/tests/…`). */
const TEST_LIKE_PATH = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?(\/|$)/i;

function resolveAllowedFiles(nodeId: string, graph: ArchitectureGraph, progress: ArchitectureProgress): string[] {
  const slug = nodeId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const implemented = progress.nodes[nodeId]?.implemented_files ?? [];
  if (implemented.length > 0) {
    // Etalono ## Failai (2): KIEKVIENAS produkcinis failas ateina su testo keliu sąraše.
    // `implemented_files` yra vien produkcijos rinkinys, tad be šio papildymo kiekvienas jau
    // aptikto mazgo task'as krinta į `production-file-without-test`. Etalonas tokiam atvejui
    // nurodo įrašyti NUMATOMĄ vardą (klaidingas konkretus kelias pastebimas, jo nebuvimas — ne).
    return implemented.some((file) => TEST_LIKE_PATH.test(file))
      ? implemented
      : [...implemented, `src/tests/${slug}.test.ts`];
  }
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  return [`src/${slug}.ts`, `src/tests/${slug}.test.ts`];
}

function renderEvidenceBlock(evidence: EvidenceEntry[]): string {
  if (evidence.length === 0) {
    return "## Evidence\n\n_No evidence entries found. Evidence repair required._\n";
  }
  const lines = evidence.map((e) => `- [${e.source}] ${e.excerpt} _(node: ${e.node_id}, ${e.timestamp})_`);
  return `## Evidence\n\n${lines.join("\n")}\n`;
}

function renderUpstreamNotes(contract: NodeInterfaceContract): string {
  if (contract.upstream.length === 0) return "";
  const lines = contract.upstream.map((u) => `- upstream node: \`${u}\``);
  if (contract.inputs.length > 0) {
    contract.inputs.forEach((inp) => lines.push(`  - input: ${inp}`));
  }
  return lines.join("\n");
}

function renderStackSection(stackDecision: StackDecision | undefined): string[] {
  if (!stackDecision) return [];
  return [
    ``,
    `## Stack`,
    ``,
    `- language: ${stackDecision.selectedLanguage ?? "(not specified)"}`,
    `- framework: ${stackDecision.selectedFramework ?? "(not specified)"}`,
    `- architectureStyle: ${stackDecision.architectureStyle}`,
  ];
}

function renderDownstreamNotes(contract: NodeInterfaceContract): string {
  if (contract.downstream.length === 0) return "";
  const lines = contract.downstream.map((d) => `- downstream node: \`${d}\``);
  if (contract.outputs.length > 0) {
    contract.outputs.forEach((out) => lines.push(`  - output: ${out}`));
  }
  return lines.join("\n");
}

export function synthesizeTask(input: SynthesisInput): SynthesizedTask {
  const { nodeId, graph, progress, evidence, contract, runId, specSource, stackDecision } = input;

  const node = graph.nodes.find((n) => n.id === nodeId);
  const nodeLabel = node?.label ?? nodeId;

  const allowedFiles = resolveAllowedFiles(nodeId, graph, progress);

  const upstreamNotes = renderUpstreamNotes(contract);
  const downstreamNotes = renderDownstreamNotes(contract);

  const interfaceParts: string[] = [];
  if (upstreamNotes) interfaceParts.push(`**Upstream:**\n${upstreamNotes}`);
  if (downstreamNotes) interfaceParts.push(`**Downstream:**\n${downstreamNotes}`);
  if (contract.public_exports.length > 0) {
    interfaceParts.push(`**Expected exports:** ${contract.public_exports.join(", ")}`);
  }
  // Kontrakto patikros yra SPEC'O tekstas, ne vykdomos komandos: `## Patikra` priima tik etalono
  // sandbox formas (`pnpm build`, `pnpm test`), tad spec'e rasta `npm run test` ten duotų
  // `patikra-unknown-command` ir parkuotų kiekvieną sintezuotą task'ą. Čia jos lieka matomos
  // vykdytojui kaip PAPRASTAS tekstas — be backtick'ų, kad `parseBacktickChecks` jų nepaimtų.
  if (contract.checks.length > 0) {
    interfaceParts.push(`- Kontrakto patikros: ${contract.checks.join("; ")}`);
  }
  const interfaceSection =
    interfaceParts.length > 0 ? interfaceParts.join("\n\n") : "_Nėra upstream/downstream sąsajų._";

  const allowedFilesBlock = allowedFiles.map((f) => `- \`${f}\``).join("\n");

  // `## Patikra` — VISADA etalono dvi komandos, nepriklausomai nuo kontrakto. Dvi taisyklės
  // susitinka: (1) komandos PRIVALO būti backtick'uose, nes context-pack parseTaskMarkdown ir
  // preflight parseBacktickChecks atpažįsta tik `- \`cmd\`` formą (2026-07-07 code_scaner
  // incidentas: 4 run-tree užduotys krito su "missing ## Patikra", nors sekcija buvo);
  // (2) komanda privalo būti etalono ALLOWED_PATIKRA_COMMANDS sąraše — spec'o `npm run test`
  // čia reikštų `patikra-unknown-command`. Kontrakto patikros keliauja į `## Veiksmas`.
  const checksBlock = "- `pnpm build`\n- `pnpm test`";

  // Kanoninė OpenSpec nuoroda (jei yra) eina PIRMA — ją atpažįsta preflight
  // analyzeOpenSpecReferences; architecture-node eilutė lieka traceability.
  const specSourceLines = specSource
    ? [specSource, `architecture-node/${nodeId} (run: ${runId})`]
    : [`architecture-node/${nodeId} (run: ${runId})`];

  const parts: string[] = [
    `# Task`,
    ``,
    `## Spec source`,
    ``,
    ...specSourceLines,
    ``,
    `## Tikslas`,
    ``,
    `Įgyvendinti \`${nodeLabel}\` (node \`${nodeId}\`) pagal architektūros grafą ir evidence.`,
  ];

  if (node?.description) {
    parts.push(``, node.description);
  }

  parts.push(...renderStackSection(stackDecision));

  parts.push(
    ``,
    `## Agentai`,
    ``,
    serializeAgentChain(["readme-guard", "architect", "coder", "reviewer", "tester", "documenter"]),
    ``,
    `## Failai`,
    ``,
    `Leidžiama:`,
    allowedFilesBlock,
    ``,
    `Draudžiama:`,
    `- \`.env\`, \`.env.*\``,
    `- \`node_modules/**\`, \`dist/**\``,
    `- visi kiti failai`,
    ``,
    `## Veiksmas`,
    ``,
    interfaceSection,
    ``,
    `## Patikra`,
    ``,
    checksBlock,
    ``,
    `## Stop`,
    ``,
    `Sustoti kai patikros praeina ir pakeitimai apsiriboja leidžiamais failais.`,
    ``,
    `## Neįtraukta`,
    ``,
    `- LLM kvietimai ar dinaminė sintezė.`,
    `- Queue loop vykdymas.`,
    ``,
    renderEvidenceBlock(evidence),
  );

  const markdown = parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();

  return {
    run_id: runId,
    node_id: nodeId,
    node_label: nodeLabel,
    evidence_count: evidence.length,
    allowed_files: allowedFiles,
    markdown,
  };
}

export async function writeSynthesisOutput(
  fs: ArchitectureStateFsPort,
  statePath: string,
  result: SynthesizedTask,
): Promise<void> {
  const outputPath = path.join(statePath, `${result.run_id}.json`);
  await fs.writeTextFile(outputPath, JSON.stringify(result, null, 2));
}
