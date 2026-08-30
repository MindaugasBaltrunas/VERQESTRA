// LLM preflight pusė (etalonas: claude-preflight/index.ts prompt + attempt blokas):
// bazinis prompt'as su TOK-2 reduced skale, skaldymo/koregavimo direktyvos ir vienas
// LLM bandymas su infrastruktūros sąlygų apdorojimu (429 → USAGE_LIMIT_EXIT_CODE,
// max-turns → atskiras kind su vienu no-tools retry, ne-nulinis kodas → propaguojamas).

import path from "node:path";
import { USAGE_LIMIT_EXIT_CODE } from "../../../../shared/exit-codes.js";
import { extractSection, findSectionBounds } from "../../../../shared/markdown.js";
import { allowedPaths } from "../../../../domain/tasks/allowed-paths.js";
import { detectHallucinatedAllowedPaths } from "../../../../application/quality-gates/preflight-rules.js";
import type { PreflightLimits } from "../../../../application/policy-governance/preflight-limits-policy.js";
import type { ClaudePreflightPorts, PreflightDecision } from "./preflight-ports.js";

export type PromptScale = "full" | "reduced";

/**
 * Kanoninio task šablono kelias citavimui prompt'uose (070-c-04). Etalono pilnas turinys
 * (`AG/tasks/examples/000-etalonas.md`, ~120 eilučių) NEĮtraukiamas į kiekvieną preflight LLM
 * kvietimą — tai sudegintų `taskChars`/`specChars` biudžetą be proporcingo naudos; vietoje to
 * čia gyvena deterministiškai iš jo išvestas kompaktiškas taisyklių rinkinys, kurio LLM
 * negali praleisti pro akis (visada prisegtas, ne `.slice()`-inamas kaip kintantis kontekstas).
 */
export const ETALONAS_TEMPLATE_PATH = "AG/tasks/examples/000-etalonas.md";

/** Etalono kanoninė sekcijų tvarka (000-etalonas.md), abiem promptams — 1:1 su antraštėmis. */
const ETALONAS_SECTION_ORDER =
  "# Task / ## Spec source / ## Priklausomybės / ## Žingsnis 0 — ar jau įgyvendinta? / ## Tikslas / " +
  "## Agentai / ## Failai / ## Veiksmas / ## Patikra / ## Stop / ## Neįtraukta";

/**
 * `## Failai` taisyklės iš etalono (2026-08-28: 5 parkavimai „changed files outside allowed
 * paths" kilo iš improvizuotų kelių šioje sekcijoje). Tas pats tekstas, kurį jau naudoja
 * deterministinis vartas (`evaluateEtalonasRuleViolations`), kad LLM ir vartas sutartų, KO
 * tikimasi, PRIEŠ reformulaciją, ne po jos.
 */
const ETALONAS_FAILAI_RULES =
  `- Etalono šablonas (${ETALONAS_TEMPLATE_PATH}) sekcijų tvarka: ${ETALONAS_SECTION_ORDER}.\n` +
  "- `## Failai` keliai PRIVALO būti konkretūs, ne katalogo wildcard'as (`src/tests/**`, `components/`) — " +
  "wildcard'as leidžiamas TIK visos apimties migracijai su pagrindimo tekstu šalia kelio.\n" +
  "- Kiekvienas produkcinis failas `## Failai` sąraše ateina su savo testo failu (numatomas vardas su " +
  "išlyga, jei tikslus dar nežinomas).\n" +
  "- UI task'as VISADA įtraukia `ui-app/src/i18n/I18nContext.tsx` ir `ui-app/src/view/styles/dashboard.css`.\n" +
  "- `Draudžiama:` įvardija gretimą sluoksnį, svetimą modulį, `dist/**`, `node_modules/**`.";

export type PreflightPromptContext = {
  taskId: string;
  activeText: string;
  openSpecContext: string;
  architectureRules: string;
  /** Kableliais sujungti žinomi agentai prompt'ui. */
  availableAgents: string;
  modelSelectionRules: string;
};

/** Etalono buildBasePrompt 1:1 (tekstas nekeičiamas — tai LLM elgesio kontraktas). */
export function buildBasePrompt(context: PreflightPromptContext, scale: PromptScale): string {
  const reduced = scale === "reduced";
  const taskChars = reduced ? 3000 : 6000;
  const specChars = reduced ? 1200 : 12000;
  const rulesChars = reduced ? 600 : 1800;
  return `Tu esi AG queue supervisor. Tu skaitai MD užduotis po vieną ir visą vykdymą deleguoji Claude.

Taisyklės:
- Nekeisk produkto kodo.
- Nerašyk patch.
- Gali skaityti visus šio repo failus ir katalogus, įskaitant produkto kodą, \`.claude/\`, \`AG/\`, dokumentaciją, konfigūraciją ir logus.
- Sprendimui dažniausiai pakanka žemiau pateikto konteksto (užduotis, OpenSpec, architektūros taisyklės) — repo failus skaityk tik kai tikrai būtina, keliais tiksliniais Read/Grep, be plataus repo tyrinėjimo.
- Tikrink, ar užduotis atitinka architektūrą, agentų grandines ir projekto gaires.
- Jei yra OpenSpec kontekstas, naudok jį kaip produkto intenciją, bet AGENTS.md/CLAUDE.md architektūros taisyklės lieka viršesnės.
- Jei užduotis netinka projektui, performuluok taip, kad funkcionalumas išliktų, bet įgyvendinimas atitiktų projektą.
- Galutinis rezultatas turi būti trumpa, aiški Claude užduotis.
- Neperduok Claude viso originalaus task teksto kaip vieno didelio bloko.
- Jei originali užduotis turi daug temų, kelis modulius ar daug žingsnių, \`claude_task\` turi apimti tik pirmą vieną aiškiai vykdomą darbą.
- Jei originali užduotis turi kelis nepriklausomus darbus, išskaidyk juos į mažas nuoseklias užduotis: pirmą įrašyk į \`claude_task\`, o likusias eilės tvarka į \`child_tasks\`.
- Kiekvienas \`child_tasks[].claude_task\` turi būti pilnas savarankiškas Claude promptas tokiu pačiu trumpu formatu kaip \`claude_task\`.
- Nerašyk Claude prompto kaip kelių užduočių sąrašo. Vienas \`claude_task\` = vienas konkretus darbas.
- Jei matai, kad originalą reikia vykdyti per 8 darbus, nebandyk visų 8 aprašyti viename Claude prompt'e; palik tik pirmą darbą, o likusius trumpai paminėk eilutėje \`Neįtraukta\`.
- \`claude_task\` privalo naudoti tik šį trumpą formatą:
  \`# Task\`
  \`## Spec source\`
  \`## Tikslas\`
  \`## Agentai\`
  \`## Failai\`
  \`## Veiksmas\`
  \`## Patikra\`
  \`## Stop\`
  \`## Neįtraukta\`
- Skyriuje \`## Agentai\` privalo būti ta pati agentų grandinė kaip \`target_agent_chain\`.
- Jei originali užduotis turi aktyvų \`openspec/changes/<change-id>/\` arba \`AG/openspec/changes/<change-id>/\`, \`## Spec source\` privalo pakartoti kanoninę \`openspec/changes/<change-id>/\` nuorodą.
- Skyriuje \`## Veiksmas\` leidžiama ne daugiau kaip 3 bullet punktai.
- Skyriuje \`## Failai\` (ir claude_task, ir kiekvieno child_tasks[].claude_task) keliai PRIVALO būti backtick'uose po \`Leidžiama:\` / \`Draudžiama:\` žymeklių, po vieną kelią eilutėje (pvz. - \`AG/project/status.md\`). Be backtick kelių vaiko preflight negali patikrinti scope ir task'as krenta į human-review.
- Skyriuje \`## Patikra\` (ir claude_task, ir kiekvieno child_tasks[].claude_task) PRIVALO būti bent viena vykdoma komanda backtick'uose, po vieną komandą eilutėje (pvz. - \`pnpm test\`). Be backtick komandų preflight negali patikrinti patikrų ir task'as krenta į human-review.
- Privalai parinkti Claude agentų grandinę ir įrašyti ją į target_agent_chain.
- Autoritetingas agentų sąrašas yra \`.claude/agents/*.md\`; agento vardas yra failo pavadinimas be \`.md\`.
- target_agent_chain gali naudoti tik agentus iš šio sąrašo (automatiškai nuskaitytas iš .claude/agents/): ${context.availableAgents}.
- readme-guard VISADA turi būti pirmas grandinėje kai keičiamas source kodas — leidimą suteikia tik PostToolUse Read hooko įrašytas README skaitymo įrodymas, ne rankinis flagas.
- Claude užduotyje aiškiai nurodyk: ką daryti, kad privaloma naudoti nurodytą agentų grandinę, kokias patikras paleisti, kada commitinti ir sustoti.
${ETALONAS_FAILAI_RULES}
${context.modelSelectionRules}
- SVARBU: Grąžink TIK JSON objektą be jokių markdown, komentarų ar paaiškinimų. Tiksliai šie laukai:
  {
    "verdict": "delegate" | "reformulate_delegate" | "human_review" | "reject",
    "task_id": "<string>",
    "architecture_valid": <boolean>,
    "was_reformulated": <boolean>,
    "selected_model": "haiku" | "sonnet" | "opus",
    "target_agent_chain": ["<agent>", ...],
    "reason": "<string, max 1000 chars>",
    "claude_task": "<full task prompt using # Task / ## Spec source / ## Tikslas / ## Agentai / ## Failai / ## Veiksmas / ## Patikra / ## Stop / ## Neįtraukta format>",
    "child_tasks": [{"title": "<string>", "claude_task": "<string>"}]
  }

## Task ID
${context.taskId}

## Užduotis
${context.activeText.slice(0, taskChars)}

## OpenSpec kontekstas
${context.openSpecContext.slice(0, specChars)}

## Architektūros pagrindinės taisyklės
${context.architectureRules.slice(0, rulesChars)}`;
}

/**
 * Skaldymo direktyva (etalono splitDirective 1:1 + 070-c-04 etalono papildymai). 2026-08-28
 * per parą 2 skėlimai krito `duplicate_scope` vartu (`enqueueChildTasks`,
 * `application/task-execution/enqueue-child-tasks.ts`) — vaikai gavo TAPAČIĄ `## Failai`
 * aibę, ir antrasis brolis neturėjo ką dispatch'inti. Šios dvi papildomos eilutės uždaro tą
 * spragą PRIEŠ generavimą, ne po nepavykusio bandymo.
 */
export function splitDirective(sizeViolations: string[], limits: PreflightLimits, strict: boolean): string {
  return (
    `\n\n## DYDŽIO RIBA VIRŠYTA\nŠi užduotis VIRŠIJA konfigūruotą dydžio ribą: ${sizeViolations.join("; ")}.\n` +
    `PRIVALAI grąžinti \`child_tasks\` su bent viena papildoma nuoseklia užduotimi (iš viso ≥2 mažos užduotys).\n` +
    `\`claude_task\` privalo apimti TIK pirmą mažą, savarankiškai vykdomą dalį ir pats NEVIRŠYTI ribų ` +
    `(≤${limits.maxDomains} domenai, ≤${limits.maxAllowedPaths} failai, ≤${limits.maxActionBullets} veiksmai, ≤${limits.maxLines} eilutės).\n` +
    `Etalono šablonas (${ETALONAS_TEMPLATE_PATH}) sekcijų tvarka: ${ETALONAS_SECTION_ORDER}.\n` +
    `SVARBU (skėlimas): kiekvieno \`child_tasks[].claude_task\` \`## Failai\` scope NEGALI persidengti nė vienu keliu su kitu vaiku — ` +
    `bendras failas reiškia arba sujungti abu vaikus į vieną, arba iškelti bendrą pakeitimą į atskirą, pirmesnį vaiką, ` +
    `nuo kurio kiti priklauso per \`## Priklausomybės\`. Persidengęs scope blokuoja VISĄ skėlimą (\`duplicate_scope\`).\n` +
    `SVARBU (skėlimas): jei skeli UI ir serverio darbą, UI vaikas \`## Priklausomybės\` PRIVALO nurodyti serverio vaiko task id — niekada atvirkščiai.` +
    (strict
      ? `\nANKSTESNIS bandymas nesuskaldė pakankamai — skaldyk SMULKIAU: kiekvieną domeną/feature į atskirą child task.`
      : "")
  );
}

export const NO_TOOLS_DIRECTIVE =
  "\n\nSVARBU: ankstesnis bandymas viršijo įrankių žingsnių limitą. NEnaudok jokių įrankių — " +
  "sprendimui pakanka aukščiau pateikto konteksto. Grąžink TIK galutinį JSON objektą.";

export const EMPTY_VERDICT_DIRECTIVE =
  "\n\nSVARBU: ankstesnis tavo atsakymas NEBUVO validus JSON (verdict neperskaitytas). " +
  "Grąžink TIK vieną validų JSON objektą — be markdown, be ```json fence, be preambulės. " +
  'VISOS dvigubos kabutės string reikšmių viduje (ypač claude_task) privalo būti escape\'intos kaip \\". ' +
  "Tekste vietoj „...\" porų naudok paprastas 'single' kabutes, kad nekiltų escape klaidų.";

export const PATIKRA_DIRECTIVE =
  "\n\nSVARBU: ankstesnis tavo claude_task \"## Patikra\" sekcijoje neturėjo NĖ VIENOS backtick komandos. " +
  "\"## Patikra\" PRIVALO turėti bent vieną vykdomą komandą backtick'uose, po vieną eilutėje (pvz. - `pnpm test`). " +
  "Grąžink TIK galutinį JSON objektą su pataisytu claude_task.";

export type PreflightAttemptOutcome =
  /** exitCode jau nustatytinas kvietėjo; halt reiškia „grįžk iš komandos". */
  | { kind: "halt"; exitCode: number }
  /** Biudžeto/vertinimo klaida — kvietėjas rašo human-review sprendimą su šia priežastimi. */
  | { kind: "human-review"; reason: string }
  | { kind: "max_turns" }
  | { kind: "ok"; decision: PreflightDecision };

export type PreflightLlmRunnerContext = {
  taskId: string;
  taskFile: string;
  model: string;
  /** Apskaitos pakopa (preflightTier), rašoma į token-usage. */
  tier: string;
  maxTurns: number;
  buildPrompt(scale: PromptScale): string;
  /** Pre-LLM aktyvus task tekstas — hallucinated-allowed-path guard'o originalo šaltinis. */
  taskText: string;
};

/**
 * Reformuluoto `claude_task` `## Failai` keliai, kurių tėvinis katalogas ĮRODYTAI neegzistuoja
 * (grynoji taisyklė — `detectHallucinatedAllowedPaths`). `dirExists` yra async portas: tėviniai
 * katalogai suresolvinami VIENĄ kartą prieš kviečiant grynąją taisyklę su sinchroniniu
 * predikatu, sudarytu iš jau žinomų atsakymų (nežinomas kelias predikate — fail-open `true`,
 * bet tai neįvyksta, nes žemėlapis apima kiekvieną kandidatą).
 */
async function findHallucinatedAllowedPaths(
  claudeTask: string,
  dirExists: (relativeDir: string) => Promise<boolean>,
): Promise<string[]> {
  const parentExists = new Map<string, boolean>();
  for (const candidate of allowedPaths(claudeTask)) {
    if (candidate.includes("*")) continue;
    const parent = path.posix.dirname(candidate.replace(/\\/g, "/"));
    if (parent === "." || parentExists.has(parent)) continue;
    parentExists.set(parent, await dirExists(parent));
  }
  return detectHallucinatedAllowedPaths(claudeTask, (dir) => parentExists.get(dir) ?? true);
}

/** Pakeičia `claude_task` `## Failai` sekcijos KŪNĄ originalaus (pre-LLM) task teksto sekcija. */
function replaceFailaiSectionWithOriginal(claudeTask: string, originalTaskText: string): string {
  const lines = claudeTask.split(/\r?\n/);
  const bounds = findSectionBounds(lines, (line) => line.trim() === "## Failai");
  if (bounds === undefined) return claudeTask;
  const originalBody = extractSection(originalTaskText, "## Failai");
  if (!originalBody) return claudeTask;
  return [...lines.slice(0, bounds.start + 1), originalBody, "", ...lines.slice(bounds.end)].join("\n");
}

/**
 * LLM reformulacijos apsauga (task 045-a-02): jei `claude_task` `## Failai` nurodo kelią, kurio
 * tėvinio katalogo NĖRA, LLM sugalvojo kelią. Grąžinam ORIGINALO `## Failai` sekciją ir garsiai
 * pažymim žurnale (`CLAUDE PREFLIGHT: ... hallucinated-allowed-path`); niekas kitas sprendime
 * nekeičiamas. Fail-open: be flagged kelių arba be `## Failai`/originalo sekcijos — nieko nedaro.
 */
async function guardAgainstHallucinatedAllowedPaths(
  ports: ClaudePreflightPorts,
  context: PreflightLlmRunnerContext,
  decision: PreflightDecision,
): Promise<PreflightDecision> {
  const claudeTask = decision.claude_task;
  if (!claudeTask) return decision;
  const flagged = await findHallucinatedAllowedPaths(claudeTask, (dir) => ports.files.dirExists(dir));
  if (flagged.length === 0) return decision;
  const patched = replaceFailaiSectionWithOriginal(claudeTask, context.taskText);
  if (patched === claudeTask) return decision;
  await ports.agLog(
    `CLAUDE PREFLIGHT: task=${context.taskId} hallucinated-allowed-path: LLM claude_task ## Failai referenced ` +
      `non-existent path(s) (${flagged.join(", ")}) — reverted ## Failai to original task section`,
  );
  return { ...decision, claude_task: patched };
}

/**
 * Vieno LLM bandymo vykdytojas (etalono runPreflightAttempt 1:1). Kiekvienas bandymas
 * autorizuojamas atskirai (TOK-2 — pirmasis galėjo sudeginti likutį); prompt'as kaupiamas
 * attempt log'e (append-only) ir perrašo globalų preflight-input.md.
 */
export function createPreflightLlmRunner(ports: ClaudePreflightPorts, context: PreflightLlmRunnerContext) {
  const supervisorLogPath = path.join(ports.runtimeRoot, "logs", "supervisor-last.log");
  return async function runPreflightAttempt(suffix: string): Promise<PreflightAttemptOutcome> {
    let authorization;
    try {
      authorization = await ports.authorizeLlmCall(context.taskId, "preflight");
    } catch (error: unknown) {
      return {
        kind: "human-review",
        reason: `Token budget could not be evaluated before preflight: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!authorization.allowed) {
      return { kind: "human-review", reason: `Token budget exhausted before preflight: ${authorization.hard_reasons.join("; ")}` };
    }
    if (authorization.reduce_context) {
      await ports.agLog(
        `CLAUDE PREFLIGHT: task=${context.taskId} budget soft limit — reduced prompt context: ${authorization.soft_reasons.join("; ")}`,
      );
    }
    const promptText = `${context.buildPrompt(authorization.reduce_context ? "reduced" : "full")}${suffix}`;
    // Kanoninis įrašas PAPILDOMAS (append-only): iki trijų LLM bandymų globalų
    // preflight-input.md perrašo vienas kitą, o attempt log'e jie kaupiasi.
    await ports.attempt.appendPreflightInput(promptText);
    await ports.files.writePreflightInput(promptText);

    // TOK-02: turn limitas kerpa repo vaikščiojimo uodegą; limitą pasiekus claude -p
    // baigiasi NENULINIU kodu su subtype error_max_turns — atskiras kind su vienu
    // no-tools koregavimo retry, ne bendras halt.
    const result = await ports.runHeadless(promptText, context.model, {
      maxTurns: context.maxTurns,
      disallowWriteTools: true,
    });
    await ports.files.writeSupervisorLog(`${result.stdout}${result.stderr}`);
    await ports.logTokenUsage("preflight", context.tier, result.stdout);

    // API/sesijos limitas (429) — infrastruktūra, ne task'o kaltė: USAGE_LIMIT_EXIT_CODE
    // grąžina task'ą į queue, o loop'as palaukia cooldown ir tęsia pats.
    if (ports.isUsageLimitOutput(result.stdout)) {
      await ports.recordResumeCheckpoint({
        actor: "supervisor",
        phase: "preflight",
        status: "failed",
        task_id: context.taskId,
        task_file: context.taskFile,
        log_file: supervisorLogPath,
        exit_code: USAGE_LIMIT_EXIT_CODE,
        next_action: "Claude API limit reached — loop waits for the cooldown and resumes",
      });
      ports.stderr("Claude API limitas pasiektas (429) — task grįžta į queue, loop lauks cooldown");
      return { kind: "halt", exitCode: USAGE_LIMIT_EXIT_CODE };
    }

    if (result.code !== 0) {
      if (result.stdout.includes('"subtype":"error_max_turns"')) {
        await ports.agLog(
          `CLAUDE PREFLIGHT: task=${context.taskId} llm hit max-turns limit (${context.maxTurns}) — corrective no-tools retry`,
        );
        return { kind: "max_turns" };
      }
      await ports.recordResumeCheckpoint({
        actor: "supervisor",
        phase: "preflight",
        status: "failed",
        task_id: context.taskId,
        task_file: context.taskFile,
        log_file: supervisorLogPath,
        exit_code: result.code,
        next_action: "Read supervisor-last.log, fix preflight issue or move task to human review",
      });
      // Be šio logo nenulinis LLM exit palikdavo tik "preflight_failed=1" be priežasties.
      await ports.agLog(`CLAUDE PREFLIGHT: task=${context.taskId} llm attempt failed exit=${result.code} — see supervisor-last.log`);
      ports.stderr(result.stderr || result.stdout);
      return { kind: "halt", exitCode: result.code };
    }

    const decision = await guardAgainstHallucinatedAllowedPaths(ports, context, ports.parseDecision(result.stdout));
    return { kind: "ok", decision };
  };
}

/** Etalono maxTurnsParkReason 1:1 (kelias — VERQESTRA display forma). */
export function maxTurnsParkReason(maxTurns: number): string {
  return `Preflight LLM viršijo max-turns limitą (${maxTurns}) du kartus — task per platus preflight sesijai; suskaidyk rankiniu būdu arba padidink llmMaxTurns/turnLimits.semanticReview vq/config/preflight-limits.json.`;
}
