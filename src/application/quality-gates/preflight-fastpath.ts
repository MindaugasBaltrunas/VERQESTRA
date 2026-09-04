// TOK-01: deterministinis preflight fast-path (etalonas: AG_loop orchestrator/quality/
// deterministic-preflight.ts 1:1).
//
// Split-vaikų `claude_task` sugeneruoja TĖVO preflight LLM jau kanoniniu formatu ir
// `enqueueChildTasks` jį validavęs įrašo į queue — o ištraukus vaiką, claude-preflight
// paleisdavo DAR VIENĄ pilną LLM kvietimą (~$0.4–0.95 opus) tam pačiam, jau kanoniniam
// tekstui. Šis modulis yra veidrodinis deterministic-diagnose greitkeliui: grynas
// sprendimas be I/O virš precomputed signalų. fastPath=true tik kai VISI kanoniškumo
// signalai galioja — tada dispatch'inama be LLM. Konservatyvus pagal dizainą: bet koks
// abejotinas signalas (trūkstama sekcija, prozinė grandinė, nežinomas agentas, dydžio
// pažeidimas, tušti scope keliai) grąžina fastPath=false ir kreipiamasi į LLM.
//
// Saugikliai nepakinta: risk gates, size gate, OpenSpec validacija ir readme-guard
// normalizavimas vykdomi PRIEŠ šį sprendimą (jie ir dabar deterministiniai), o
// quality gates + diagnose tikrina rezultatą PO dispatch'o.

import { parseAgentChain } from "../../domain/policies/agent-selection.js";
import { validateTaskAgainstEtalonas } from "../../domain/tasks/etalonas-rules.js";

// Sankcionuoti interfaces → application → domain tiltai preflight CLI adapteriui (tas pats
// šablonas kaip evaluateRepeatedErrorEscalation retry-repair.ts): adapteris grynas domain
// taisykles ima per šį modulį, ne tiesioginiu interfaces → domain importu.
export { exceedsLimits, measureTaskSize } from "../../domain/tasks/size.js";
export { allowedPaths } from "../../domain/tasks/allowed-paths.js";
export { analyzeHumanReviewGates } from "../../domain/tasks/human-review/gates.js";
export { classifyTask } from "../../domain/policies/task-classification.js";
export { serializeAgentChain } from "../../domain/policies/agent-selection.js";
export { taskLedgerKey } from "../../domain/tasks/identity.js";
export { extractSection } from "../../shared/markdown.js";

export type DeterministicPreflightSignals = {
  /** Trūkstamos HARD sekcijos (# Task, ## Spec source, ## Tikslas, ## Veiksmas, ## Stop). */
  missingHardSections: string[];
  /** Trūkstamos SOFT sekcijos (## Agentai, ## Failai, ## Patikra, ## Neįtraukta). */
  missingSoftSections: string[];
  /** Size gate pažeidimai iš `exceedsLimits`; tuščias = ribose. */
  sizeViolations: string[];
  /** `## Failai` → `Leidžiama:` backtick kelių skaičius (bendras `allowedPaths` parseris). */
  allowedPathCount: number;
  /** `## Patikra` backtick komandų skaičius (bendras `parseBacktickChecks` parseris). */
  backtickCheckCount: number;
  /** Pilnas `## Agentai` sekcijos turinys ("" jei sekcijos nėra). */
  agentaiSection: string;
  /** Žinomi agentai iš `.claude/agents/*.md` (basename be .md). */
  knownAgents: string[];
};

export type DeterministicPreflightResult = {
  /** True = saugu dispatch'inti be LLM preflight; false = kreiptis į LLM. */
  fastPath: boolean;
  /** Trumpas paaiškinimas (telemetrijai/log'ui). */
  reason: string;
  /** Išparsinta agentų grandinė (tuščia kai fastPath=false). */
  chain: string[];
};

/**
 * Ištraukia agentų grandinę iš `## Agentai` sekcijos PIRMOS ne tuščios eilutės.
 * Toleruojamas įžanginis label'is iki dvitaškio („Privaloma naudoti grandinę: ...");
 * agentų varduose dvitaškių nebūna, tad nukirtimas saugus. Likusios sekcijos eilutės
 * (prozinės instrukcijos vykdytojui) grandinei įtakos neturi — grandinę producers
 * visada rašo vienoje eilutėje.
 */
export function extractChainFromAgentaiSection(section: string): string[] {
  const firstLine =
    section
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const colonIdx = firstLine.indexOf(":");
  const withoutLabel = colonIdx === -1 ? firstLine : firstLine.slice(colonIdx + 1);
  return parseAgentChain(withoutLabel);
}

export function evaluateDeterministicPreflight(signals: DeterministicPreflightSignals): DeterministicPreflightResult {
  const no = (reason: string): DeterministicPreflightResult => ({ fastPath: false, reason, chain: [] });

  if (signals.missingHardSections.length > 0) {
    return no(`missing hard sections: ${signals.missingHardSections.join(", ")}`);
  }
  // `## Neįtraukta` yra grynai informacinė: hasFatalSectionGap jos nelaiko fatal,
  // o dispatch saugumui (scope, patikros, grandinė) ji nieko neduoda. Queue
  // generatoriai jos dažnai nerašo, ir vien dėl to kanoniniai task'ai keliaudavo
  // į LLM preflight (etalono 2026-07-03 telemetrija: hit rate 8/195). Likusios SOFT
  // sekcijos (## Agentai/## Failai/## Patikra) toliau privalomos — jas naudoja
  // dispatch ir diagnose vartai.
  const requiredSoftMissing = signals.missingSoftSections.filter((section) => section !== "## Neįtraukta");
  if (requiredSoftMissing.length > 0) {
    return no(`missing soft sections: ${requiredSoftMissing.join(", ")}`);
  }
  if (signals.sizeViolations.length > 0) {
    return no(`size violations: ${signals.sizeViolations.join("; ")}`);
  }
  if (signals.allowedPathCount === 0) {
    // Be backtick scope kelių diagnose negalėtų patikrinti pakeitimų ribų — LLM keliui.
    return no("no backtick allowed paths in ## Failai");
  }
  if (signals.backtickCheckCount === 0) {
    // Context-pack parseTaskMarkdown dispatch metu HARD-reikalauja bent vienos backtick
    // komandos ## Patikra sekcijoje — fastpath be šio signalo dispatch'indavo task'ą,
    // kurį context-pack iškart numesdavo į human-review (etalono 2026-07-07 code_scaner
    // atvejis: 4 run-tree užduotys su checkbox patikromis be backtick'ų). LLM kelias
    // turi koreguojantį retry (needsPatikraChecksRetry) — juo ir naudojamės.
    return no("no backtick checks in ## Patikra");
  }

  const chain = extractChainFromAgentaiSection(signals.agentaiSection);
  if (chain.length === 0) {
    return no("empty agent chain in ## Agentai");
  }
  const known = new Set(signals.knownAgents);
  const unknown = chain.filter((agent) => !known.has(agent));
  if (unknown.length > 0) {
    // Prozinė grandinė („...documenter. readme-guard pirmas perskaito...") arba
    // neegzistuojantis agentas — abu atvejai keliauja į LLM normalizavimą.
    return no(`unknown agent tokens in ## Agentai: ${unknown.join(", ").slice(0, 160)}`);
  }

  return {
    fastPath: true,
    reason: "task already canonical: sections complete, size within limits, chain valid, scoped paths present",
    chain,
  };
}

// --- Etalono kanoniškumo taisyklės (070-a-02, adapteris nuo 156-a-02) --------------------
//
// `evaluateDeterministicPreflight` sprendžia TIK ar saugu praleisti LLM preflight'ą; ji
// tyliai praleidžia task'ą, kuris formaliai turi visas sekcijas, bet pažeidžia etalono
// (`AG/tasks/examples/000-etalonas.md`) turinio taisykles — pvz. katalogo wildcard'ą be
// pagrindimo, ar UI failus be I18nContext/dashboard.css.
//
// 156-a-02: taisyklių ĮGYVENDINIMO čia nebeliko. Iki tol pre-write hook'as
// (`interfaces/hooks/pre-hooks.ts` per `validateTaskAgainstEtalonas`) ir šis preflight vartas
// turėjo DVI nepriklausomas „kaip atrodo etaloną atitinkantis task'as" kopijas, ir jos jau
// buvo išsiskyrusios (skirtingi wildcard apibrėžimai, skirtingi rule id, hook'as matė sekcijų
// tvarką, o preflight'as — ne). Dabar abu keliai kviečia TĄ PATĮ domain validatorių, o šis
// modulis liko tik projekcija į preflight'o laukiamą formą (citata visada eilutė, kad
// `preflight-validate.ts` galėtų jas sujungti į reason'ą).
//
// `knownTaskIds` sąmoningai neperduodamas: task id visata gyvena FS'e, o ši funkcija yra
// gryna ir kviečiama iš LLM sprendimo validacijos, kur bucket'ų nuskaitymo nėra. Todėl
// `priklausomybe-unknown-id` čia netikrinama — visos kitos taisyklės galioja.

/**
 * Etalono taisyklės id. Reikšmes gamina domain `validateTaskAgainstEtalonas`, ir adapteris jas
 * perduoda NEPAKITUSIAS — todėl tipas atviras (`string`), o ne užrakinta unija: kiekviena nauja
 * domain taisyklė (task 157) kitaip reikalautų antros, atsiliekančios kopijos būtent toje
 * vietoje, kurią 156-a-02 ir naikina. Šiandien gaminami id: `mandatory-section-missing`,
 * `mandatory-section-order`, `failai-wildcard-without-justification`,
 * `production-file-without-test`, `ui-file-without-i18n-context`, `ui-file-without-dashboard-css`,
 * `priklausomybe-placeholder`, `patikra-without-backtick-check`, `patikra-unknown-command`.
 */
export type EtalonasRuleId = string;

export type EtalonasRuleViolation = {
  ruleId: EtalonasRuleId;
  /** Žmogui skaitoma citata iš `000-etalonas.md`, įvardijanti pažeistą taisyklę. */
  citation: string;
  /** Konkretus radinys šiame task'e (kelias/eilutė), pagrindžiantis pažeidimą. */
  detail: string;
};

/**
 * Etalono kanoniškumo taisyklių rinkinys — pilnas `taskText` grąžina pažeidimų sąrašą (tuščia =
 * nulis pažeidimų). Grynas skaičiavimas: NEI FS, NEI verdikto sprendimo — tik radiniai su
 * citatomis, kad kvietėjas (070-b-03) galėtų juos surišti su dispatch/reformulate verdiktu.
 *
 * Plonas adapteris virš domain `validateTaskAgainstEtalonas` (156-a-02). Vienintelis darbas —
 * formos projekcija: domain `citation`/`detail` yra neprivalomi (struktūrinės taisyklės, pvz.
 * `mandatory-section-missing`, citatos neturi), o preflight'as jas naudoja kaip reason'o tekstą,
 * tad trūkstamą lauką pakeičia `message` — jis visada įvardija pažeistą taisyklę ir rodo į
 * `AG/tasks/examples/000-etalonas.md`.
 */
export function evaluateEtalonasRuleViolations(taskText: string): EtalonasRuleViolation[] {
  return validateTaskAgainstEtalonas(taskText ?? "").map((violation) => ({
    ruleId: violation.ruleId,
    citation: violation.citation ?? violation.message,
    detail: violation.detail ?? violation.message,
  }));
}
