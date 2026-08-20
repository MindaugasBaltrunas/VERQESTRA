// Spec-source vartų pusė (etalonas: claude-preflight/index.ts spec-source blokas):
// architecture-node nuorodos priėmimas (task 864 kryptis 2), `## Spec source` papildymas be
// dublikatinės antraštės (task 1217) ir auto-OpenSpec generavimas su template fallback'u
// (task 882) po TOK-2 planning biudžeto vartų.

import path from "node:path";
import {
  analyzeOpenSpecReferences,
  buildOpenSpecContext,
  type OpenSpecReferenceAnalysis,
} from "../../../../application/task-planning/openspec-context.js";
import type { ClaudePreflightPorts } from "./preflight-ports.js";

const ARCHITECTURE_NODE_REF_RE = /architecture-node\/([A-Za-z0-9_.:-]+)/g;

/**
 * Task 864 kryptis (2): `ag architecture run-tree`/`synthesize-node` sintezuoja task'us
 * tiesiai iš grafo be OpenSpec change — grafas ir YRA tokių task'ų spec of record.
 * `architecture-node/<id>` nuoroda priimama kaip validus spec source, kai nurodytas mazgas
 * realiai egzistuoja dabartiniame grafe (`vq/state/architecture/graph.json`).
 */
export async function hasValidArchitectureNodeReference(
  ports: Pick<ClaudePreflightPorts, "readOptionalFile" | "runtimeRoot">,
  taskText: string,
): Promise<boolean> {
  const referencedIds = Array.from(taskText.matchAll(ARCHITECTURE_NODE_REF_RE), (match) => match[1]);
  if (referencedIds.length === 0) return false;

  const graphPath = path.join(ports.runtimeRoot, "state", "architecture", "graph.json");
  const raw = await ports.readOptionalFile(graphPath);
  if (!raw) return false;

  try {
    const graph = JSON.parse(raw) as { nodes?: Array<{ id?: string }> };
    const nodeIds = new Set((graph.nodes ?? []).map((node) => node.id));
    return referencedIds.some((id) => nodeIds.has(id));
  } catch {
    return false;
  }
}

const SPEC_SOURCE_HEADING_RE = /^## Spec source[ \t]*$/m;

/**
 * Prideda spec-source nuorodą NEgamindama antros `## Spec source` antraštės: worker-task-ir
 * kompiliatorius `## Spec source` laiko vienetine sekcija ir dublikatą atmeta su
 * `duplicate_section` (etalono task 1217 — tokie task'ai krisdavo į `raw` kompresijos
 * fallback'ą). Esant antraštei nuoroda įterpiama kaip papildoma eilutė tos sekcijos gale;
 * kitaip atidaroma nauja sekcija kaip anksčiau.
 */
export function appendSpecSourceRef(taskText: string, ref: string): string {
  if (!SPEC_SOURCE_HEADING_RE.test(taskText)) {
    return `${taskText.trimEnd()}\n\n## Spec source\n${ref}\n`;
  }
  const lines = taskText.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === "## Spec source");
  let insertAt = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i] ?? "")) {
      insertAt = i;
      break;
    }
  }
  while (insertAt > headingIndex + 1 && (lines[insertAt - 1] ?? "").trim() === "") {
    insertAt -= 1;
  }
  lines.splice(insertAt, 0, ref);
  return lines.join("\n");
}

export type SpecSourceGateResult =
  | { ok: true; activeText: string; openSpecRefs: OpenSpecReferenceAnalysis; openSpecContext: string }
  | { ok: false; reason: string };

/**
 * Pilnas spec-source vartų blokas source-change task'ui be aktyvios OpenSpec nuorodos:
 * architecture-node priėmimas → auto-OpenSpec (planning biudžetas → LLM → template
 * fallback) → human-review priežastis. Sėkmės atveju grąžina galimai papildytą activeText
 * ir perskaičiuotus refs/kontekstą.
 */
export async function ensureSpecSource(
  ports: ClaudePreflightPorts,
  input: {
    taskId: string;
    activeText: string;
    openSpecRefs: OpenSpecReferenceAnalysis;
    openSpecContext: string;
    sourceChangeTask: boolean;
    autoOpenSpec: boolean;
  },
): Promise<SpecSourceGateResult> {
  let { activeText, openSpecRefs, openSpecContext } = input;
  const { taskId } = input;

  const invalidOpenSpecRefs = [
    ...openSpecRefs.archivedChangeDirs.map((ref) => `${ref} is archived`),
    ...openSpecRefs.missingChangeDirs.map((ref) => `${ref} does not exist`),
    ...openSpecRefs.templateRefs.map((ref) => `${ref} is a template`),
  ];
  if (invalidOpenSpecRefs.length > 0) {
    return { ok: false, reason: `Invalid OpenSpec reference: ${invalidOpenSpecRefs.join("; ")}` };
  }

  if (input.sourceChangeTask && openSpecRefs.activeChangeDirs.length === 0) {
    if (await hasValidArchitectureNodeReference(ports, activeText)) {
      await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} architecture-node spec source accepted (no OpenSpec change)`);
    } else if (input.autoOpenSpec) {
      // TOK-2: auto-OpenSpec generavimas yra realus LLM kvietimas (planning fazė) —
      // jis privalo praeiti tuos pačius whole-task/fazės vartus kaip preflight sprendimas.
      const planningBudget = await ports.authorizeLlmCall(taskId, "planning");
      if (!planningBudget.allowed) {
        return {
          ok: false,
          reason: `Token budget exhausted before auto-OpenSpec generation: ${planningBudget.hard_reasons.join("; ")}`,
        };
      }
      // B funkcija: trūkstant openspec — sugeneruok change'ą ir tęsk, o ne sustok.
      // LLM pirmas; nepavykus — deterministinis template fallback (task 882). Human-review
      // TIK kai net template įrašymas į diską nepavyksta.
      const openSpecGenerationModel = await ports.resolveModel("sonnet");
      let generatedRef = await ports.generateChange(activeText, taskId, ports.agRoot, openSpecGenerationModel);
      if (!generatedRef) {
        generatedRef = await ports.writeTemplateChange(activeText, taskId, ports.agRoot);
        if (generatedRef) {
          await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} auto-openspec LLM failed — deterministic template fallback`);
        }
      }
      if (!generatedRef) {
        return { ok: false, reason: "Auto-OpenSpec generation and template fallback both failed; manual spec required." };
      }
      // `## Spec source` PRIVALO rodyti į FAILĄ, ne pliką katalogą: retrieval daro readFile
      // kiekvienai spec-source eilutei, o katalogas crash'ina dispatch su EISDIR.
      // `AG/`-prefiksuotas `spec.md` yra realus failas ir vis tiek atpažįstamas kaip aktyvi
      // change nuoroda (analyzeOpenSpecReferences ištraukia dir).
      const specSourceRef = `AG/${generatedRef.replace(/\/+$/, "")}/spec.md`;
      activeText = appendSpecSourceRef(activeText, specSourceRef);
      openSpecRefs = await analyzeOpenSpecReferences(ports.openSpec, ports.projectRoot, activeText);
      if (openSpecRefs.activeChangeDirs.length === 0) {
        return { ok: false, reason: `Auto-generated OpenSpec change is not a valid active reference: ${generatedRef}` };
      }
      openSpecContext = await buildOpenSpecContext(ports.openSpec, ports.projectRoot, activeText);
      await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} auto-openspec=${specSourceRef}`);
    } else {
      return { ok: false, reason: "Source-code task is missing an active openspec/changes/<change-id>/ reference." };
    }
  }

  if (openSpecContext === "OpenSpec context not found for this task.") {
    return { ok: false, reason: "OpenSpec context not found for this task." };
  }

  return { ok: true, activeText, openSpecRefs, openSpecContext };
}
