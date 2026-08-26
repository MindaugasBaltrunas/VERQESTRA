// Deterministic execution-context renderer (CTX-1..CTX-3). Behaviour etalon: AG_loop
// application/context-pack/render-execution-context.ts.
//
// `context-pack.json` stays the machine artifact. This module turns one schema-valid pack
// into the short, prioritized `execution-context.md` handed to the coding worker. Pure: no
// clock, no randomness, no I/O — the same pack and the same char limit always produce a
// byte-identical document and the same fingerprint.
//
// KĄ dokumentas neša ir kokia tvarka — `render-candidates`. Čia lieka tik tai, KAIP kandidatų
// sąrašas virsta dokumentu: biudžeto metimo ciklas, netikimo turinio aptvaras ir fingerprint'as.

import { createHash } from "node:crypto";
import { parseWithSchema } from "../../shared/schema.js";
import { buildCandidates, type Candidate } from "./render-candidates.js";
import { EXECUTION_CONTEXT_FILENAME } from "./execution-context-fingerprint.js";
import {
  EXECUTION_CONTEXT_VERSION,
  executionContextSchema,
  RETRIEVED_DATA_TAG,
  TRUST_BOUNDARY_RULE,
  type ContextPack,
  type ExecutionContext,
  type ExecutionContextElement,
  type ExecutionContextPriority,
} from "./context-pack-schema.js";

export type RenderExecutionContextOptions = {
  // Hard upper bound for the rendered markdown, in characters. Defaults to the pack's
  // own `budget.max_context_chars`, falling back to DEFAULT_EXECUTION_CONTEXT_MAX_CHARS.
  maxChars?: number;
  /**
   * Praleisti kandidatus, kurių kūnas yra to paties task failo lauko atspindys (`taskDerived`:
   * goal, acceptance criteria, allowed paths, checks, out of scope). Skirta VIENINTELIAM
   * skaitytojui — worker prompt'ui, kuris patį task'ą jau neša pilną, tad tie blokai jame būtų
   * antra to paties teksto kopija (task 029).
   *
   * Diske gulinčiam `execution-context.md` NENAUDOJAMA: artefaktas skaitomas savarankiškai,
   * be task failo šalia, ir privalo likti pilnas. Nenurodyta arba `false` — elgesys nesikeičia
   * baitas į baitą.
   *
   * Kandidatai išmetami PRIEŠ biudžeto ciklą, tad atlaisvintus simbolius perima įrodymai
   * (spec fragmentai, SRC pjūviai), kurie kitaip būtų iškritę. Dokumentas dėl to niekada
   * neišauga virš `maxChars` ir, kai nieko nebuvo metama, yra griežtai trumpesnis.
   */
  excludeTaskDerived?: boolean;
};

export type RenderedExecutionContext = {
  markdown: string;
  // Machine-readable side of the same render: kept elements with their metadata plus the
  // elements that had to be dropped to honour the char limit.
  context: ExecutionContext;
};

export const DEFAULT_EXECUTION_CONTEXT_MAX_CHARS = 12000;

// Placeholder of exactly the same width as a real fingerprint. The drop loop renders with
// it so that the measured length never depends on the fingerprint value — only on the set
// of kept elements — which keeps "fingerprint of the kept set" free of circularity.
const FINGERPRINT_PLACEHOLDER = "0".repeat(16);

// Droppable priorities, in the order they are given up. `critical` is absent on purpose:
// goal, acceptance criteria, allowed paths and checks are never dropped.
const DROP_ORDER: readonly ExecutionContextPriority[] = ["low", "medium", "high"];

const OPEN_TAG_PREFIX = `<${RETRIEVED_DATA_TAG}`;
const CLOSE_TAG = `</${RETRIEVED_DATA_TAG}>`;

/**
 * Ekranuoja aptvaro žymes PAČIAME kūne, kad cituojamas tekstas negalėtų jo uždaryti ir toliau
 * atrodyti kaip patikima dokumento dalis. Grąžinamas ir pakeitimų skaičius: svetimo teksto
 * keitimas skelbiamas meta eilutėje, o ne daromas tyliai.
 */
function fenceBody(body: string): { text: string; escaped: number } {
  let escaped = 0;
  const text = body.replace(new RegExp(`</?${RETRIEVED_DATA_TAG}`, "gi"), (match) => {
    escaped += 1;
    return `&lt;${match.slice(1)}`;
  });
  return { text, escaped };
}

function attributeValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render one context pack into the worker-facing execution context.
 *
 * Element order is canonical (see `buildCandidates`) and independent of the pack's key
 * order. If the document exceeds the limit, droppable elements are removed lowest priority
 * first and, within one priority, from the end of the canonical order. Dropping is reported
 * both in the document header and, with per-element reasons, in `context.dropped`.
 *
 * `options.excludeTaskDerived` gamina SIAURESNĮ, prompt'ui skirtą to paties pack'o vaizdą
 * (task 029); be jos — nepakitęs, artefaktui skirtas dokumentas.
 *
 * @throws Error when the limit cannot be met even with every droppable element removed.
 * Failing loudly is deliberate: silently truncating the goal, the allowed-path edit
 * boundary or the checks would hand the worker an unsafe context.
 */
export function renderExecutionContext(
  pack: ContextPack,
  options: RenderExecutionContextOptions = {},
): RenderedExecutionContext {
  const maxChars = resolveMaxChars(pack, options);
  const all = buildCandidates(pack);
  // Praleidimas skaičiuojamas iš PRAEITO sąrašo, ne iš vėliavos: `excludeTaskDerived` ties
  // pack'u be nė vieno tokio bloko yra no-op ir antraštės eilutės neprideda.
  const omittedTaskDerived = options.excludeTaskDerived === true ? all.filter(isTaskDerived).length : 0;
  const candidates = omittedTaskDerived > 0 ? all.filter((candidate) => !isTaskDerived(candidate)) : all;

  const kept = [...candidates];
  const dropped: Candidate[] = [];
  for (const priority of DROP_ORDER) {
    if (renderDocument(pack, kept, dropped.length, maxChars, FINGERPRINT_PLACEHOLDER, omittedTaskDerived).length <= maxChars) {
      break;
    }
    for (let index = lastIndexOfPriority(kept, priority); index >= 0; index = lastIndexOfPriority(kept, priority)) {
      dropped.push(...kept.splice(index, 1));
      if (
        renderDocument(pack, kept, dropped.length, maxChars, FINGERPRINT_PLACEHOLDER, omittedTaskDerived).length <=
        maxChars
      ) {
        break;
      }
    }
  }

  const elements = kept.map(toElement);
  const fingerprint = computeFingerprint(pack, elements, maxChars);
  const markdown = renderDocument(pack, kept, dropped.length, maxChars, fingerprint, omittedTaskDerived);
  if (markdown.length > maxChars) {
    throw new Error(
      `execution context exceeds max_chars ${markdown.length} > ${maxChars} with only non-droppable elements left ` +
        `(goal, acceptance criteria, allowed paths, checks); raise the context budget for task ${pack.task_id}`,
    );
  }

  const context = parseWithSchema(
    executionContextSchema,
    {
      version: EXECUTION_CONTEXT_VERSION,
      task_id: pack.task_id,
      phase: pack.phase,
      goal: pack.goal,
      fingerprint,
      max_chars: maxChars,
      rendered_chars: markdown.length,
      elements,
      dropped: dropped.map((candidate) => ({
        id: candidate.id,
        section: candidate.section,
        priority: candidate.priority,
        reason: candidate.reason,
        estimated_chars: candidate.body.length,
      })),
    },
    "execution-context",
  );

  return { markdown, context };
}

function resolveMaxChars(pack: ContextPack, options: RenderExecutionContextOptions): number {
  const requested = options.maxChars ?? pack.budget?.max_context_chars ?? DEFAULT_EXECUTION_CONTEXT_MAX_CHARS;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error(`execution context max_chars must be a positive integer, received ${String(requested)}`);
  }
  return requested;
}

function isTaskDerived(candidate: Candidate): boolean {
  return candidate.taskDerived === true;
}

function lastIndexOfPriority(candidates: Candidate[], priority: ExecutionContextPriority): number {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (candidates[index]?.priority === priority) {
      return index;
    }
  }
  return -1;
}

function toElement(candidate: Candidate): ExecutionContextElement {
  return {
    id: candidate.id,
    section: candidate.section,
    title: candidate.title,
    priority: candidate.priority,
    reason: candidate.reason,
    source_hash: sourceHash(candidate),
    estimated_chars: candidate.body.length,
    body: candidate.body,
    trust: candidate.provenance === undefined ? "trusted" : "untrusted",
    ...(candidate.provenance === undefined ? {} : { provenance: candidate.provenance }),
    ...(candidate.truncated === true ? { truncated: true } : {}),
  };
}

function sourceHash(candidate: Candidate): string {
  return sha256Hex(candidate.body).slice(0, 12);
}

// The fingerprint covers element identity and size, not the rendered layout, so it stays
// stable across cosmetic changes to the markdown while still changing whenever the
// contents, the order, the priorities or the applied limit change.
//
// `trust`, `provenance` ir `truncated` čia įtraukti SĄMONINGAI, nors jie ir nekeičia kūno
// baitų: jie keičia, ką tas kūnas REIŠKIA. Blokas, tapęs `untrusted`, arba fragmentas, tapęs
// nukirptu, yra kitas dokumentas — o be jų fingerprint'as sakytų „tas pats", ir bet kuris
// skirtumo ieškantis skaitytojas to pokyčio nepamatytų.
function computeFingerprint(pack: ContextPack, elements: ExecutionContextElement[], maxChars: number): string {
  const identity = JSON.stringify({
    version: EXECUTION_CONTEXT_VERSION,
    task_id: pack.task_id,
    phase: pack.phase,
    max_chars: maxChars,
    elements: elements.map((element) => [
      element.id,
      element.section,
      element.priority,
      element.source_hash,
      element.estimated_chars,
      element.trust,
      element.provenance?.type ?? "",
      element.provenance?.source ?? "",
      element.truncated === true,
    ]),
  });
  return sha256Hex(identity).slice(0, 16);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Header fields are all derived from the kept/dropped sets or from inputs — never from the
// document's own length — so rendering converges: every drop strictly shrinks the result.
function renderDocument(
  pack: ContextPack,
  kept: Candidate[],
  droppedCount: number,
  maxChars: number,
  fingerprint: string,
  omittedTaskDerived: number,
): string {
  // Taisyklė yra NEIŠMETAMA ir stovi PRIEŠ bet kokį cituojamą turinį: vartas, kuris ateina po
  // duomenų, jau nebėra vartas. Ji renderinama net kai `untrusted` elementų nėra — tada ji
  // kainuoja kelis šimtus simbolių, bet dokumento reikšmė nepriklauso nuo to, kas į jį pateko.
  const header = [
    "# Execution context",
    "",
    `- task: ${pack.task_id}`,
    `- phase: ${pack.phase}`,
    `- context_version: ${EXECUTION_CONTEXT_VERSION}`,
    `- fingerprint: \`${fingerprint}\``,
    `- char_limit: ${maxChars}`,
    `- elements: ${kept.length} kept, ${droppedCount} dropped (lowest priority first)`,
    // Praleidimas skelbiamas, o ne daromas tyliai: be šios eilutės deduplikuotas vaizdas
    // atrodytų kaip artefaktas, kuriam tiesiog nepavyko surinkti goal/checks — o tai tiksliai
    // tas signalas, kurio skaitytojas neturi gauti. Eilutė atsiranda TIK dedup vaizde, tad
    // artefakto baitai nesikeičia.
    ...(omittedTaskDerived > 0
      ? [
          `- task_derived: ${omittedTaskDerived} element(s) omitted — the prompt carries the task itself; ` +
            `this is the dispatch view, not the \`${EXECUTION_CONTEXT_FILENAME}\` audit artifact`,
        ]
      : []),
    "",
    ...TRUST_BOUNDARY_RULE.split("\n").map((line) => `> ${line}`),
  ].join("\n");

  return [header, ...kept.map(renderBlock)].join("\n\n") + "\n";
}

function renderBlock(candidate: Candidate): string {
  const provenance = candidate.provenance;
  const meta = [
    `priority: ${candidate.priority}`,
    `reason: ${candidate.reason}`,
    `source: sha256:${sourceHash(candidate)}`,
    `chars: ${candidate.body.length}`,
    `trust: ${provenance === undefined ? "trusted" : "untrusted"}`,
    ...(candidate.truncated === true ? ["truncated: yes"] : []),
  ];

  const notice = candidate.notice === undefined ? "" : `${candidate.notice}\n\n`;

  if (provenance === undefined) {
    return `## ${candidate.title}\n\n> ${meta.join(" | ")}\n\n${notice}${candidate.body}`;
  }

  const { text, escaped } = fenceBody(candidate.body);
  if (escaped > 0) {
    meta.push(`escaped_fences: ${escaped}`);
  }
  const open =
    `${OPEN_TAG_PREFIX} type="${attributeValue(provenance.type)}"` +
    ` source="${attributeValue(provenance.source)}" trust="untrusted">`;
  return `## ${candidate.title}\n\n> ${meta.join(" | ")}\n\n${notice}${open}\n${text}\n${CLOSE_TAG}`;
}
