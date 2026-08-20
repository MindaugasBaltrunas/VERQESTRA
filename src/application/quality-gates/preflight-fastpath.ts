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
