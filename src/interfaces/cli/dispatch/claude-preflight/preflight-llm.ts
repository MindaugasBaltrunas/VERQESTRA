// LLM preflight pusė (etalonas: claude-preflight/index.ts prompt + attempt blokas):
// bazinis prompt'as su TOK-2 reduced skale, skaldymo/koregavimo direktyvos ir vienas
// LLM bandymas su infrastruktūros sąlygų apdorojimu (429 → USAGE_LIMIT_EXIT_CODE,
// max-turns → atskiras kind su vienu no-tools retry, ne-nulinis kodas → propaguojamas).

import path from "node:path";
import { USAGE_LIMIT_EXIT_CODE } from "../../../../shared/exit-codes.js";
import type { PreflightLimits } from "../../../../application/policy-governance/preflight-limits-policy.js";
import type { ClaudePreflightPorts, PreflightDecision } from "./preflight-ports.js";

export type PromptScale = "full" | "reduced";

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

/** Skaldymo direktyva (etalono splitDirective 1:1). */
export function splitDirective(sizeViolations: string[], limits: PreflightLimits, strict: boolean): string {
  return (
    `\n\n## DYDŽIO RIBA VIRŠYTA\nŠi užduotis VIRŠIJA konfigūruotą dydžio ribą: ${sizeViolations.join("; ")}.\n` +
    `PRIVALAI grąžinti \`child_tasks\` su bent viena papildoma nuoseklia užduotimi (iš viso ≥2 mažos užduotys).\n` +
    `\`claude_task\` privalo apimti TIK pirmą mažą, savarankiškai vykdomą dalį ir pats NEVIRŠYTI ribų ` +
    `(≤${limits.maxDomains} domenai, ≤${limits.maxAllowedPaths} failai, ≤${limits.maxActionBullets} veiksmai, ≤${limits.maxLines} eilutės).` +
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
};

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

    return { kind: "ok", decision: ports.parseDecision(result.stdout) };
  };
}

/** Etalono maxTurnsParkReason 1:1 (kelias — VERQESTRA display forma). */
export function maxTurnsParkReason(maxTurns: number): string {
  return `Preflight LLM viršijo max-turns limitą (${maxTurns}) du kartus — task per platus preflight sesijai; suskaidyk rankiniu būdu arba padidink llmMaxTurns/turnLimits.semanticReview vq/config/preflight-limits.json.`;
}
