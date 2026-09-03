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
import { allowedPaths as allowedPathsInternal } from "../../domain/tasks/allowed-paths.js";
import { extractSection as extractSectionInternal } from "../../shared/markdown.js";
import { parseBacktickChecks } from "./preflight-rules.js";

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

// --- Etalono kanoniškumo taisyklės (070-a-02) -------------------------------------------
//
// `evaluateDeterministicPreflight` sprendžia TIK ar saugu praleisti LLM preflight'ą; ji
// tyliai praleidžia task'ą, kuris formaliai turi visas sekcijas, bet pažeidžia etalono
// (`AG/tasks/examples/000-etalonas.md`) turinio taisykles — pvz. katalogo wildcard'ą be
// pagrindimo, ar UI failus be I18nContext/dashboard.css. Šis rinkinys yra GRYNAS ir
// ADITYVUS: jis tik SKAIČIUOJA pažeidimus su konkrečios etalono taisyklės citata; verdikto
// (fastPath/dispatch/reformulate) jis nepriima — surišimą daro kvietėjas (070-b-03).

export type EtalonasRuleId =
  | "wildcard-scope-without-justification"
  | "production-file-without-test"
  | "ui-file-without-i18n-context"
  | "ui-file-without-dashboard-css"
  | "patikra-without-backtick-check"
  | "priklausomybes-placeholder";

export type EtalonasRuleViolation = {
  ruleId: EtalonasRuleId;
  /** Žmogui skaitoma citata iš `000-etalonas.md`, įvardijanti pažeistą taisyklę. */
  citation: string;
  /** Konkretus radinys šiame task'e (kelias/eilutė), pagrindžiantis pažeidimą. */
  detail: string;
};

const BROAD_SCOPE_PATH = /^(\*\*|.+\/\*\*)$/;
const TEST_LIKE_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR_SEGMENT = /(^|\/)tests?(\/|$)/i;
const SOURCE_FILE_EXTENSION = /\.(m|c)?[jt]sx?$/i;

const I18N_CONTEXT_PATH = "ui-app/src/i18n/I18nContext.tsx";
const DASHBOARD_STYLE_DIR = "ui-app/src/view/styles/";

/**
 * Bet kuris dashboard'o stilių failas. Iki 2026-09-03 čia buvo įkaltas vienas vardas
 * (`dashboard.css`) — tada jis ir buvo vienintelis. Po jo suskaidymo įkaltas vardas verstų
 * KIEKVIENĄ UI task'ą deklaruoti failą, kurio jis neredaguoja, o realų pakeitimą
 * (`view/styles/13-buttons.css`) diagnozė matytų kaip išėjimą už leistinų kelių. Taisyklės
 * KETINIMAS nesikeičia: nauja className privalo ateiti kartu su deklaruotu CSS failu.
 */
function isDashboardStylePath(path: string): boolean {
  return path.startsWith(DASHBOARD_STYLE_DIR) && path.endsWith(".css");
}

function isTestLikePath(path: string): boolean {
  return TEST_LIKE_FILE.test(path) || TEST_DIR_SEGMENT.test(path);
}

/** Backend produkcinis failas (`src/**`, ne `ui-app/**`) — konkretus, ne testas, ne wildcard'as. */
function isBackendProductionFile(path: string): boolean {
  return (
    path.startsWith("src/") &&
    !path.startsWith("ui-app/") &&
    !path.includes("*") &&
    SOURCE_FILE_EXTENSION.test(path) &&
    !isTestLikePath(path)
  );
}

/** UI komponento/puslapio failas — ne pats I18nContext, ne testas. */
function isUiComponentFile(path: string): boolean {
  return (
    path.startsWith("ui-app/") &&
    path.endsWith(".tsx") &&
    path !== I18N_CONTEXT_PATH &&
    !isTestLikePath(path)
  );
}

/** `## Failai` sekcijos žalios eilutės — reikalingos wildcard pagrindimo (trailing text) patikrai. */
function failaiSectionLines(taskText: string): string[] {
  return extractSectionInternal(taskText ?? "", "## Failai").split(/\r?\n/);
}

/** Ar backtick'uotas `path` toje eilutėje turi bent kiek teksto po jo (pagrindimas šalia). */
function hasTrailingJustification(line: string, path: string): boolean {
  const marker = `\`${path}\``;
  const idx = line.indexOf(marker);
  if (idx === -1) return false;
  return line.slice(idx + marker.length).trim().length > 0;
}

function evaluateWildcardScopeRule(taskText: string, paths: string[]): EtalonasRuleViolation[] {
  const lines = failaiSectionLines(taskText);
  const violations: EtalonasRuleViolation[] = [];
  for (const path of paths) {
    if (!BROAD_SCOPE_PATH.test(path)) continue;
    const line = lines.find((candidate) => candidate.includes(`\`${path}\``));
    if (line && hasTrailingJustification(line, path)) continue;
    violations.push({
      ruleId: "wildcard-scope-without-justification",
      citation:
        "000-etalonas.md ## Failai (1): \"Katalogo wildcard'as (`src/tests/**`, `components/`) atima " +
        "lygiagretumą, veda preflight'ą į skėlimą ir yra leidžiamas TIK visos apimties migracijai su " +
        "pagrindimu šalia.\"",
      detail: `\`${path}\` neturi pagrindimo eilutės šalia`,
    });
  }
  return violations;
}

function evaluateProductionFileTestRule(paths: string[]): EtalonasRuleViolation[] {
  const hasBackendProductionFile = paths.some(isBackendProductionFile);
  const hasTestLikePath = paths.some(isTestLikePath);
  if (!hasBackendProductionFile || hasTestLikePath) return [];
  return [
    {
      ruleId: "production-file-without-test",
      citation:
        "000-etalonas.md ## Failai (2): \"KIEKVIENAS produkcinis failas ateina su savo testo failu " +
        'sąraše. Nežinai vardo — įrašyk numatomą su išlyga... klaidingas konkretus kelias pastebimas, ' +
        'wildcard\'as — ne."',
      detail: "## Failai turi produkcinį src/** failą, bet nė vieno testo kelio sąraše",
    },
  ];
}

function evaluateUiCoverageRule(paths: string[]): EtalonasRuleViolation[] {
  if (!paths.some(isUiComponentFile)) return [];
  const violations: EtalonasRuleViolation[] = [];
  const citationPrefix =
    "000-etalonas.md ## Failai (3): \"UI task'as VISADA įtraukia `ui-app/src/i18n/I18nContext.tsx` " +
    "(nauji tekstai) ir bent vieną `ui-app/src/view/styles/*.css` (naujos className — CSS " +
    'dengiamumo vartas)."';
  if (!paths.includes(I18N_CONTEXT_PATH)) {
    violations.push({
      ruleId: "ui-file-without-i18n-context",
      citation: citationPrefix,
      detail: `## Failai turi UI komponentą, bet ne \`${I18N_CONTEXT_PATH}\``,
    });
  }
  if (!paths.some(isDashboardStylePath)) {
    violations.push({
      ruleId: "ui-file-without-dashboard-css",
      citation: citationPrefix,
      detail: `## Failai turi UI komponentą, bet nė vieno \`${DASHBOARD_STYLE_DIR}*.css\``,
    });
  }
  return violations;
}

function evaluatePatikraBacktickRule(taskText: string): EtalonasRuleViolation[] {
  const section = extractSectionInternal(taskText ?? "", "## Patikra").trim();
  if (section.length === 0 || parseBacktickChecks(taskText).length > 0) return [];
  return [
    {
      ruleId: "patikra-without-backtick-check",
      citation:
        '000-etalonas.md ## Patikra: patikros komandos visada rašomos backtick formatu ' +
        "(`pnpm build`, `pnpm test`) — be backtick'ų diagnose/context-pack jų nemato.",
      detail: "## Patikra neturi nė vienos backtick komandos",
    },
  ];
}

const DEPENDENCY_PLACEHOLDER_TOKENS = new Set(["none", "-", "n/a", "na", "tbd", "nera", "nėra"]);

function evaluateDependencyPlaceholderRule(taskText: string): EtalonasRuleViolation[] {
  const bullets = extractSectionInternal(taskText ?? "", "## Priklausomybės")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0);
  const violations: EtalonasRuleViolation[] = [];
  for (const bullet of bullets) {
    const normalized = bullet.toLowerCase().replace(/[.]+$/, "");
    if (!DEPENDENCY_PLACEHOLDER_TOKENS.has(normalized)) continue;
    violations.push({
      ruleId: "priklausomybes-placeholder",
      citation:
        '000-etalonas.md ## Priklausomybės: "Placeholder\'iai („none", „-") draudžiami — arba tikras ' +
        'id, arba sekcijos nėra."',
      detail: `Priklausomybė "${bullet}" yra placeholder, ne tikras task id`,
    });
  }
  return violations;
}

/**
 * Etalono kanoniškumo taisyklių rinkinys — pilnas `taskText` grąžina pažeidimų sąrašą (tuščia =
 * nulis pažeidimų). Grynas skaičiavimas: NEI FS, NEI verdikto sprendimo — tik radiniai su
 * citatomis, kad kvietėjas (070-b-03) galėtų juos surišti su dispatch/reformulate verdiktu.
 */
export function evaluateEtalonasRuleViolations(taskText: string): EtalonasRuleViolation[] {
  const text = taskText ?? "";
  const paths = allowedPathsInternal(text);
  return [
    ...evaluateWildcardScopeRule(text, paths),
    ...evaluateProductionFileTestRule(paths),
    ...evaluateUiCoverageRule(paths),
    ...evaluatePatikraBacktickRule(text),
    ...evaluateDependencyPlaceholderRule(text),
  ];
}
