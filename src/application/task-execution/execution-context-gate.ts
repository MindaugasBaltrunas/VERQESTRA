// Execution context vartai ir kanoninio worker prompt'o gamyba (etalonas: AG_loop
// interfaces/cli/claude-dispatch/execution-context.ts grynoji pusė; CTX-2 + task 0002/0025).
// Application sluoksnyje, nes tą pačią gate politiką ir prompt turinį vartoja ir CLI
// dispatch'as, ir adapterio kelias — jie negali išsiskirti tarp execution paviršių.
// Pristatymo (delivery) pusė su CLI argumentais — infrastructure/adapters.
//
// NUKRYPIMAS NUO ETALONO (operatoriaus užsakymas, 2026-08-26, task 029). Etalonas prompt'e neša
// task'ą DU kartus: pilną kūną plius execution kontekstą, kuris iš to paties task failo
// perrenderina goal/acceptance/allowed-paths/checks/out-of-scope. `resolveCanonicalWorkerPrompt`
// tą antrą kopiją nuima PROMPT'O surinkimo metu (`taskDedupedExecutionContext`). Kryptis
// griežtinanti: worker'is mato tą patį turinį, tik vieną kartą, o `execution-context.md` diske
// lieka pilnas ir baitas į baitą nepakitęs — jis skaitomas savarankiškai auditui.

import { allowedPaths } from "../../domain/tasks/allowed-paths.js";
import { contextPackSchema, TRUST_BOUNDARY_RULE } from "../context-pack/context-pack-schema.js";
import { sourceSliceOrigins } from "../context-pack/source-slice-freshness.js";
import { renderExecutionContext } from "../context-pack/render-execution-context.js";
import { tryParseJson } from "../../shared/json.js";
import {
  EXECUTION_CONTEXT_FILENAME,
  contextArtifactSha256,
  parseExecutionContextMetadata,
} from "../context-pack/execution-context-fingerprint.js";
import { DECISION_TOKEN_BUDGET_TIER_KEY, parseTokenBudgetTier, type TokenBudgetTier } from "../token-governance/tiers.js";

// Dokumentacijos plėtiniai: task, kurio VISI leidžiami keliai yra dokumentai (arba
// AG task failai), nekeičia source kodo, todėl execution context jam neprivalomas.
const NON_SOURCE_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

function extensionOf(normalizedPath: string): string {
  const base = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * Ar tai source-change dispatch. Konservatyvu: neaiškus scope NĖRA laikomas source
 * pakeitimu — repair prompt'ai `## Failai` sekcijos neturi, o grandinė jiems context-pack
 * jau dabar praleidžia (advisory-skip); reikalauti execution context būtų reikalavimas
 * artefakto, kurio grandinė jiems niekada nesukuria.
 */
export function isSourceChangeDispatch(taskText: string): boolean {
  const paths = allowedPaths(taskText);
  if (paths.length === 0) {
    return false;
  }
  return paths.some((entry) => {
    const normalized = entry.replace(/\\/g, "/").trim();
    if (normalized.startsWith("AG/tasks/")) {
      return false;
    }
    return !NON_SOURCE_EXTENSIONS.has(extensionOf(normalized));
  });
}

/**
 * Ar dispatch'inamas prompt'as yra orchestrator paruoštas repair task'as. Struktūrinis
 * požymis (`# Repair Task` antraštė) lemia TIK turn biudžetą — jokio saugumo vartų
 * sprendimo nuo jo nepriklauso, tad content-sniffing rizika nulinė.
 */
export function isRepairDispatchPrompt(taskText: string): boolean {
  return /^#\s+Repair Task\s*$/m.test(taskText);
}

/**
 * Rollout politika (`AG_EXECUTION_CONTEXT_MODE`): `off` — kontekstas neskaitomas;
 * `preferred` (numatytoji) — galiojantis prisegamas, nebuvimas tik logginamas;
 * `required` — trūkstamas kontekstas source-change dispatch'e yra fail-fast.
 * Fingerprint NEATITIKIMAS — fail-fast visuose režimuose išskyrus `off`.
 */
export type ExecutionContextMode = "off" | "preferred" | "required";

export const DEFAULT_EXECUTION_CONTEXT_MODE: ExecutionContextMode = "preferred";

export function resolveExecutionContextMode(env: NodeJS.ProcessEnv = process.env): ExecutionContextMode {
  const raw = env["AG_EXECUTION_CONTEXT_MODE"]?.trim().toLowerCase();
  return raw === "off" || raw === "preferred" || raw === "required" ? raw : DEFAULT_EXECUTION_CONTEXT_MODE;
}

/** Sprendimo forma, kurios reikia tier paskelbimui — struktūrinis DecisionState poaibis. */
export type PublishedTierDecision = { task_id?: string } & Record<string, unknown>;

/**
 * Preflight paskelbtas token biudžeto tier'as iš sprendimo (task 0941). Priimamas TIK kai
 * sprendimas priklauso šiam task'ui: globalus decision.json yra vienos eilutės veidrodis,
 * o svetimo task'o tier'as duotų tylų neteisingą turn langą.
 */
export function publishedTokenBudgetTier(decision: PublishedTierDecision, taskId: string): TokenBudgetTier | undefined {
  const owner = decision.task_id?.trim();
  if (owner && owner.toLowerCase() !== taskId.trim().toLowerCase()) return undefined;
  return parseTokenBudgetTier(decision[DECISION_TOKEN_BUDGET_TIER_KEY]);
}

export type ExecutionContextGate =
  | { kind: "attach"; executionContext: string }
  | { kind: "skip"; reason: string }
  | { kind: "refuse"; reason: string };

export type ExecutionContextGateInput = {
  mode: ExecutionContextMode;
  sourceChange: boolean;
  taskId: string;
  taskText: string;
  /** `vq/supervisor/execution-context.md` turinys; tuščia/undefined = nėra artefakto. */
  executionContext?: string;
  /** `vq/supervisor/context-pack.json` turinys; tuščia/undefined = nėra artefakto. */
  contextPackText?: string;
  /**
   * Task 0002 (gyvas incidentas 1225-a): repair dispatch'o tekstas yra repair prompt'as, ne
   * originalus task'as, kuriam buvo sugeneruotas execution-context.md — grandinė repair
   * turiniui artefakto neregeneruoja. Fingerprint neatitikimas repair'e = „pasenęs", ne
   * „sukčiaujama": skip, ne refuse. Non-repair dispatch'ui laukas sprendimo nekeičia.
   */
  isRepair?: boolean;
  /**
   * Keliai, kurių SRC pjūviai pack'e nebeatitinka darbinio medžio (žr.
   * `context-pack/source-slice-freshness`), ARBA `"unchecked"`. Skaičiuoja kvietėjas, nes tik
   * jis turi IO; vartas lieka grynas ir sprendžia tik politiką.
   *
   * Laukas PRIVALOMAS ir sąjunga su `"unchecked"` yra sąmoninga. Anksčiau jis buvo optional, o
   * varte `?? []` paversdavo „nepatikrinta" į „tuščias sąrašas" — t. y. praktiškai į „šviežia",
   * nors komentaras teigė priešingai. Tipas dabar verčia KIEKVIENĄ kvietėją pasakyti, ką jis
   * žino; nutylėti nebeįmanoma.
   */
  staleSourceSlices: readonly string[] | "unchecked";
};

function validateExecutionContext(input: ExecutionContextGateInput, artifact: string): string | undefined {
  const metadata = parseExecutionContextMetadata(artifact);
  if (!metadata) {
    return `${EXECUTION_CONTEXT_FILENAME} has no <!-- ag:execution-context ... --> fingerprint header`;
  }
  if (metadata.taskId && metadata.taskId !== input.taskId) {
    return `${EXECUTION_CONTEXT_FILENAME} was rendered for task ${metadata.taskId}, dispatch task is ${input.taskId}`;
  }
  if (!metadata.taskSha256) {
    return `${EXECUTION_CONTEXT_FILENAME} fingerprint header has no task_sha256`;
  }
  const taskSha = contextArtifactSha256(input.taskText);
  if (metadata.taskSha256 !== taskSha) {
    return `${EXECUTION_CONTEXT_FILENAME} task fingerprint mismatch: context=${metadata.taskSha256} task=${taskSha}`;
  }
  if (metadata.contextPackSha256) {
    if (!input.contextPackText) {
      return `${EXECUTION_CONTEXT_FILENAME} references a context pack that is missing on disk`;
    }
    const packSha = contextArtifactSha256(input.contextPackText);
    if (metadata.contextPackSha256 !== packSha) {
      return `${EXECUTION_CONTEXT_FILENAME} context-pack fingerprint mismatch: context=${metadata.contextPackSha256} pack=${packSha}`;
    }
  }
  // Artefaktų darna dar nereiškia šviežumo: task tekstas ir pack'as gali sutapti baitas į baitą,
  // o SRC pjūvio šaltinis tuo metu jau būti perrašytas ankstesnio bandymo. Tai ta pati
  // „pasenusio konteksto" klasė kaip fingerprint neatitikimas, tad ir politika ta pati.
  const stale = input.staleSourceSlices;
  if (stale !== "unchecked" && stale.length > 0) {
    return `${EXECUTION_CONTEXT_FILENAME} embeds source slices that no longer match the working tree: ${stale.join(", ")}`;
  }

  // NEPATIKRINTA + pack'e REALIAI yra SRC snapshot'ų = tas pats kaip pasenę.
  //
  // Anksčiau čia rėmiausi tuo, kad `symbol_slices` numatytai išjungtas. Tai einamosios
  // KONFIGŪRACIJOS faktas, ne savybė: feature'as jungiamas ir turi canary režimą, tad tokia
  // „garantija" galioja tik iki pirmo konfigo pakeitimo. Todėl klausiama ne apie feature'ą, o
  // apie PATĮ pack'ą — jis čia jau yra, ir patikra gryna.
  //
  // Kai SRC pjūvių nėra, `"unchecked"` nieko nereiškia ir praleidžiama: tikrinti nėra ko.
  if (stale === "unchecked" && input.contextPackText !== undefined && packMayCarrySourceSlices(input.contextPackText)) {
    return `${EXECUTION_CONTEXT_FILENAME} embeds source slices, but this dispatch path cannot verify them against the working tree`;
  }
  return undefined;
}

/**
 * Ar pack'e yra bent vienas simbolis su `source` snapshot'u.
 *
 * Neparsinamas pack'as grąžina `true` — fail-closed: nežinodami, ar pjūvių yra, negalime
 * apsimesti, kad jų nėra. (Iki čia jis jau praėjo fingerprint patikrą, tad tai reiškia
 * sugadintą, o ne svetimą artefaktą.)
 */
function packMayCarrySourceSlices(contextPackText: string): boolean {
  const parsed = tryParseJson<unknown>(contextPackText);
  if (!parsed.ok) {
    return true;
  }
  const pack = contextPackSchema.safeParse(parsed.value);
  if (!pack.success) {
    return true;
  }
  return sourceSliceOrigins(pack.data).length > 0;
}

export function evaluateExecutionContextGate(input: ExecutionContextGateInput): ExecutionContextGate {
  if (input.mode === "off") {
    return { kind: "skip", reason: "AG_EXECUTION_CONTEXT_MODE=off" };
  }

  const artifact = input.executionContext?.trim();
  if (!artifact) {
    if (input.sourceChange && input.mode === "required") {
      return {
        kind: "refuse",
        reason: `source-change dispatch requires ${EXECUTION_CONTEXT_FILENAME}, but the artifact is missing`,
      };
    }
    return {
      kind: "skip",
      reason: input.sourceChange
        ? `${EXECUTION_CONTEXT_FILENAME} missing (mode=${input.mode}) — dispatching task text only`
        : `non-source dispatch without ${EXECUTION_CONTEXT_FILENAME}`,
    };
  }

  const failure = validateExecutionContext(input, artifact);
  if (!failure) {
    return { kind: "attach", executionContext: artifact };
  }
  // Task 0002: repair dispatch'ui pasenęs/nesutampantis kontekstas NIEKADA nėra refuse —
  // vienintelis saugus elgesys yra skip su task_id turinčiu log'u. NE-repair source-change
  // dispatch'ui mismatch/stale ir toliau fail-fast refuse.
  if (input.sourceChange && !input.isRepair) {
    return { kind: "refuse", reason: failure };
  }
  return {
    kind: "skip",
    reason: input.isRepair ? `regeneration_unavailable: ${failure}` : failure,
  };
}

/** Gate rezultatas, po kurio dispatch tęsiamas (refuse yra atskira šaka). */
export type AttachedOrSkippedGate = Exclude<ExecutionContextGate, { kind: "refuse" }>;

export type CanonicalWorkerPromptResult =
  | { kind: "prompt"; prompt: string; gate: AttachedOrSkippedGate }
  | { kind: "refuse"; reason: string };

/**
 * Task 0025: `compiledTask` KEIČIA tik prompt'o kūną; vartų fingerprint'as ir toliau
 * skaičiuojamas nuo RAW `taskText` baitų — kompresija negali susilpninti vartų.
 */
export type CanonicalWorkerPromptInput = ExecutionContextGateInput & {
  /** Kompiliuotas task kūnas (WorkerTaskIR arba compact DSL); nenurodžius — raw tekstas. */
  compiledTask?: string;
};

/**
 * Task 029: prompt'ui skirtas artefakto vaizdas be task-derived blokų.
 *
 * Prompt'as PATS neša visą task'ą (raw arba kompiliuotą kūną), o `execution-context.md` iš to
 * paties task failo perrenderina goal, acceptance criteria, allowed paths, checks ir out of
 * scope — t. y. tą patį tekstą antrą kartą. Čia ta antra kopija nukrenta; diske gulintis
 * artefaktas lieka NEPALIESTAS ir pilnas, nes jis skaitomas savarankiškai, be task failo šalia.
 *
 * FAIL-SAFE: dedup taikomas TIK kai pack'as įrodomai atkuria artefaktą baitas į baitą. Jei
 * pack'o nėra, jis neparsinamas arba jo renderis nesutampa su artefaktu, grąžinamas
 * NEPAKEISTAS artefaktas — prompt'as niekada neneša teksto, kurio nebuvo tame, ką patvirtino
 * vartai. `<!-- ag:execution-context ... -->` markeris išsaugomas: jis yra prompt'o audito
 * nuoroda į task_sha256/context_pack_sha256.
 */
function taskDedupedExecutionContext(contextPackText: string | undefined, artifact: string): string {
  if (!contextPackText) {
    return artifact;
  }
  const parsed = tryParseJson<unknown>(contextPackText);
  if (!parsed.ok) {
    return artifact;
  }
  const pack = contextPackSchema.safeParse(parsed.value);
  if (!pack.success) {
    return artifact;
  }
  let full: string;
  let deduped: string;
  try {
    full = renderExecutionContext(pack.data).markdown.trimEnd();
    deduped = renderExecutionContext(pack.data, { excludeTaskDerived: true }).markdown.trimEnd();
  } catch {
    // Renderis meta tik tada, kai biudžetas nepasiekiamas. Prompt'o gamyba dėl to negali kristi:
    // vartai artefaktą jau patvirtino, tad teisingas elgesys yra jį atiduoti tokį, koks yra.
    return artifact;
  }
  if (!artifact.endsWith(full)) {
    return artifact;
  }
  return `${artifact.slice(0, artifact.length - full.length)}${deduped}`;
}

/**
 * CTX-2: VIENINTELĖ vieta, kuri iš task teksto + execution context artefakto pagamina
 * workeriui skirtą prompt'ą — gate politika ir turinys negali išsiskirti tarp paviršių.
 *
 * Task 029: vartų SPRENDIMAS (`attach`/`skip`/`refuse`) ir jo fingerprint'ai skaičiuojami nuo
 * RAW `taskText` ir nuo disko artefakto — dedup vyksta PO jų ir jų nepasiekia.
 */
export function resolveCanonicalWorkerPrompt(input: CanonicalWorkerPromptInput): CanonicalWorkerPromptResult {
  const gate = evaluateExecutionContextGate(input);
  if (gate.kind === "refuse") {
    return { kind: "refuse", reason: gate.reason };
  }
  return {
    kind: "prompt",
    prompt: buildWorkerPrompt({
      taskText: input.taskText,
      ...(input.compiledTask === undefined ? {} : { compiledTask: input.compiledTask }),
      ...(gate.kind === "attach"
        ? { executionContext: taskDedupedExecutionContext(input.contextPackText, gate.executionContext) }
        : {}),
    }),
    gate,
  };
}

export const WORKER_PROMPT_CONTEXT_HEADING = "# Execution context";

/**
 * Vienintelė vieta, kur gimsta workeriui siunčiamas tekstas. Grynas ir deterministinis —
 * Windows ir non-Windows keliai negali išsiskirti. Be execution context grąžinamas
 * NEPAKEISTAS task tekstas; `compiledTask` PAKEIČIA raw kūną, o ne prisideda prie jo.
 */
export function buildWorkerPrompt(parts: {
  taskText: string;
  executionContext?: string;
  compiledTask?: string;
}): string {
  const body = parts.compiledTask?.trim() ? parts.compiledTask : parts.taskText;
  const context = parts.executionContext?.trim();
  if (!context) {
    return body;
  }
  // Riba skelbiama PRIEŠ pridedamą kontekstą ir po task'o teksto — būtent toje siūlėje, kur
  // baigiasi tai, ką parašė orkestratorius, ir prasideda tai, kas paimta iš failų. Taisyklė
  // kartojama, nors ji yra ir pačiame `execution-context.md`: prompt'as yra vienintelis
  // paviršius, kurį modelis tikrai mato, o dubliavimas čia yra apsauga, ne triukšmas.
  return [
    body.replace(/\s+$/, ""),
    "",
    "---",
    "",
    TRUST_BOUNDARY_RULE,
    "",
    WORKER_PROMPT_CONTEXT_HEADING,
    "",
    context,
    "",
  ].join("\n");
}

/**
 * F11 + CTX-2: preview riba taikoma TIK žmogui skirtam dispatch log įrašui — realus
 * prompt'as niekada nekerpamas.
 */
export const MAX_PROMPT_PREVIEW_CHARS = 12_000;

export function workerPromptPreview(prompt: string, taskFile: string, maxChars = MAX_PROMPT_PREVIEW_CHARS): string {
  if (prompt.length <= maxChars) {
    return prompt;
  }
  return `${prompt.slice(0, maxChars)}\n\n[...sutrumpinta. Pilnas failas: ${taskFile}]`;
}
