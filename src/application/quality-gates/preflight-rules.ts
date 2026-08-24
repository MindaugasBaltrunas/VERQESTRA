// Preflight taisyklių GRYNOJI pusė: claude_task sekcijų taksonomija, source-change
// šablonas, backtick patikrų parseris, verdiktų/normalizavimo taisyklės ir architektūros/
// enforcement vartai. Behaviour etalon: AG_loop application/quality-gates/preflight-rules.ts.
// Etalone `evaluateArchitectureAndPolicyGates` pats skaitė policy failus; VERQESTRA jis yra
// GRYNAS — politikas paduoda kvietėjas (loaderiai — policy-governance), tad vartus galima
// varyti testais be FS. parseBacktickChecks yra worker-task-ir kompiliatoriaus kanoninis
// parseris (FQC-12: vienas parseris visame repo).

import { extractSection, findSectionBounds } from "../../shared/markdown.js";
import { serializeAgentChain } from "../../domain/policies/agent-selection.js";
import {
  detectForbiddenDependencyViolations,
  type ArchitectureStylePolicy,
} from "../../domain/policies/architecture-style.js";
import { decideEnforcement, type EnforcementLevel } from "../../domain/policies/enforcement-level.js";
import type { TaskClassification } from "../../domain/policies/task-classification.js";

// Single source of truth for the `claude_task` section taxonomy, shared by the manual
// preflight validator and the production-loop preflight normalizer. The taxonomy below and
// the routing outcomes (human-review vs fix vs delegate) follow the preflight rule core doc.
//
// CORE: structurally required everywhere; there is no recovery path for a task
// missing these (not even the loop's LLM reformulation step can meaningfully
// invent a goal, stop condition or action list).
export const CORE_REQUIRED_SECTIONS = ["# Task", "## Spec source", "## Tikslas", "## Veiksmas", "## Stop"];
// SCOPED: required for a complete task. Manual preflight never runs an LLM, so
// it treats these as fatal too; the production loop's LLM preflight step can
// still add a missing one during reformulation.
export const SCOPED_REQUIRED_SECTIONS = ["## Agentai", "## Failai", "## Patikra"];
// INFORMATIONAL: never fatal anywhere.
export const INFORMATIONAL_SECTIONS = ["## Neįtraukta"];
export const ALL_REQUIRED_HEADINGS = [...CORE_REQUIRED_SECTIONS, ...SCOPED_REQUIRED_SECTIONS];

// Safe default source-directory conventions the source-change gate always recognizes, even
// with no project profile. Purely additive prefiksų aibė (task 888).
const DEFAULT_SOURCE_CHANGE_PREFIXES = [
  "apps",
  "modules",
  "packages",
  "workers",
  "internal",
  "cmd",
  "lib",
  "pkg",
  "app",
  "services",
  "src",
];

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the source-change detection pattern from the safe defaults above plus any project
 * profile `source_roots` (task 888): a custom-named root (e.g. a bare `frontend/`) is folded
 * in by its first path segment. `AG/orchestrator/` lieka fiksuotas atvejis — AG-formos
 * target projekto elgesio paritetui.
 */
export function buildSourceChangePattern(profileSourceRoots?: string[]): RegExp {
  const prefixes = new Set(DEFAULT_SOURCE_CHANGE_PREFIXES);
  for (const root of profileSourceRoots ?? []) {
    const firstSegment = root.replace(/\\/g, "/").replace(/^\.\//, "").split("/")[0]?.trim();
    if (firstSegment) prefixes.add(firstSegment);
  }
  const alternation = [...prefixes].map(escapeRegExpLiteral).join("|");
  return new RegExp(`\\b(?:${alternation})\\/|\\bmodule\\.manifest\\.ts\\b|\\bAG\\/orchestrator\\/|\\bAG\\\\orchestrator\\/`, "i");
}

/** True when `taskText` looks like a source-code change per {@link buildSourceChangePattern}. */
export function isSourceChangeTask(taskText: string, profileSourceRoots?: string[]): boolean {
  return buildSourceChangePattern(profileSourceRoots).test(taskText);
}

/** `## Spec source` section, one trimmed non-empty line per entry. */
export function extractSpecSources(taskText: string): string[] {
  return extractSection(taskText ?? "", "## Spec source")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * `## Patikra` sekcijos backtick patikros — vienintelis eksportuotas parseris, naudojamas
 * ir manual preflight, ir context-pack (worker-task-ir), ir production-loop preflight.
 * context-pack traktuoja tuščias patikras kaip "Malformed task"; be šio patikrinimo LLM
 * reformuluotas claude_task su tuščiu `## Patikra` praeidavo preflight ir dispatch metu
 * context-pack krisdavo (task 872).
 */
export function parseBacktickChecks(taskText: string | undefined): string[] {
  return Array.from(extractSection(taskText ?? "", "## Patikra").matchAll(/`([^`]+)`/g), (match) =>
    (match[1] ?? "").trim(),
  ).filter(Boolean);
}

// --- Production-loop preflight normalization rules ---------------------------
//
// Pure verdict/section/normalization rules for the automatic loop preflight. CLI adapteris
// (E5) laiko tik argv/render/exit IO, o sprendžiamos taisyklės gyvena čia — anchored to
// the CORE/SCOPED/INFORMATIONAL taxonomy above so the loop and manual preflight cannot drift.

// HARD sections are the CORE structurally-required headings (no recovery path if
// missing). SOFT sections are advisory: the loop's LLM reformulation can still add
// a missing one, so their absence must never hard-block a task to human-review.
export const HARD_SECTIONS = CORE_REQUIRED_SECTIONS;
export const SOFT_SECTIONS = [...SCOPED_REQUIRED_SECTIONS, ...INFORMATIONAL_SECTIONS];

// Žingsnis 0: eilė kaupia pasenusius taskus (2026-06-11 auditas: 8/10 human-review
// jau buvo įgyvendinti) — vykdytojas pirmiausia patikrina, ar darbas jau padarytas.
// ALREADY_IMPLEMENTED markerį diagnosis 'done' kelias priima vietoj naujo commit'o.
//
// Sandbox taisyklių blokas (2026-08-04): dvi dispatch sesijos iš eilės sudegino dešimtis
// turns bandydamos hook'ų atmetamas komandų formas. Tekstas išlieka, bet KOMANDOS nebe
// įrašytos į jį — etalone jos buvo `npm run build --prefix AG/orchestrator` ir
// `pnpm --dir AG/orchestrator ...`, o VERQESTRA tokių komandų NETURI.
//
// VQ-703: agentui duota komanda, kurios projekte nėra, yra blogesnė už jokią — jis ją paleis,
// gaus klaidą ir sudegins būtent tuos turns, kuriuos šis blokas turi taupyti. Todėl komandos
// dabar yra ĮVESTIS, o jų šaltinis — projekto kokybės politika ir kanoninė perstatymo komanda.
export type VerificationCommands = {
  /** Kanoninė perstatymo komanda (`DIST_REBUILD_COMMAND`). */
  rebuild: string;
  /** Patikros, kurias projektas realiai deklaruoja (`quality-policy` scope komandos). */
  checks: readonly string[];
};

export function verificationPreamble(commands: VerificationCommands): string {
  const checks = commands.checks.length > 0 ? commands.checks : [commands.rebuild];
  return `## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO \`src\` pakeitimo \`dist\` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: \`${commands.rebuild}\`
- Patikroms naudok tik: ${checks.map((check) => `\`${check}\``).join(" ir ")} (be \`--\`, be pipe į kitas komandas).
- \`echo\`, \`sed\`, \`node -e\` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

`;
}

export function missingTaskSections(task: string | undefined): { hard: string[]; soft: string[] } {
  const content = task ?? "";
  return {
    hard: HARD_SECTIONS.filter((s) => !content.includes(s)),
    soft: SOFT_SECTIONS.filter((s) => !content.includes(s)),
  };
}

/**
 * True only when claude_task omits a MANDATORY (HARD) section. Missing advisory
 * (SOFT) sections are NOT fatal: the normalizing LLM that rewrites the task
 * non-deterministically drops a trailing advisory section (most often ## Neįtraukta),
 * and that must never park an otherwise valid task to human-review.
 */
export function hasFatalSectionGap(task: string | undefined): boolean {
  return missingTaskSections(task).hard.length > 0;
}

/**
 * True when a preflight decision carries no verdict (missing/blank). An empty
 * verdict signals a malformed or empty LLM response — almost always a transient
 * API condition rather than a deliberate decision — so it must be retried/left in
 * queue, not parked to human-review.
 */
export function isEmptyVerdict(decision: { verdict?: string } | undefined): boolean {
  return (decision?.verdict ?? "") === "";
}

/**
 * True when a delegate/reformulate_delegate decision's `claude_task` has zero
 * parseable `## Patikra` backtick checks (task 926 — corrective retry instead of
 * generic human-review). `human_review`/`reject` decisions are exempt: they never
 * dispatch a claude_task, so an empty ## Patikra there is not a defect.
 */
export function needsPatikraChecksRetry(decision: { verdict?: string; claude_task?: string } | undefined): boolean {
  const verdict = decision?.verdict ?? "";
  if (verdict !== "delegate" && verdict !== "reformulate_delegate") {
    return false;
  }
  return parseBacktickChecks(decision?.claude_task).length === 0;
}

/**
 * readme-guard PRIVALO būti pirmas source-change task'o grandinėje: jis perskaito
 * README ir jo Read hook įrašo įrodymą, be kurio pre-write hook blokuoja source
 * edits. LLM nepatikimai jį prideda, todėl normalizuojame deterministiškai —
 * įterpiame priekyje, pašalindami galimą dublį toliau grandinėje. Tuščia arba jau
 * teisinga grandinė grąžinama nepakeista.
 */
export function ensureReadmeGuardFirst(chain: string[]): string[] {
  if (chain.length === 0 || chain[0] === "readme-guard") {
    return chain;
  }
  return ["readme-guard", ...chain.filter((agent) => agent !== "readme-guard")];
}

/**
 * Deterministinis legacy/near-kanoninių sekcijų normalizavimas, taikomas loop'o
 * preflight PRIEŠ bet kokį gate'ą (task 882). Suvedžia žinomas legacy formas į kanoninę
 * taksonomiją, kad tas pats task'as praeitų sekcijų ir patikrų gate'us ir būtų deleguotas.
 * NEkeičia užduoties prasmės — tik antraštes ir backtick formatavimą; jau kanoninis
 * tekstas grąžinamas nepakeistas. `## Tikslas` niekada nesintetinamas.
 */
export function normalizeLegacyTaskSections(taskText: string | undefined): string {
  let text = taskText ?? "";
  // 1. Legacy antraščių pervadinimas (eilutės pradžia, label case-insensitive).
  text = text.replace(/^(#{2,3})[ \t]+Reikalavimai[ \t]*$/gim, "## Veiksmas");
  text = text.replace(/^(#{2,3})[ \t]+Stop[ \t]+condition[ \t]*$/gim, "## Stop");
  // 2. Užtikrinam kanoninį `# Task` (HARD sekcija; gate'ai tikrina substring `# Task`).
  if (!/^#[ \t]+Task\b/m.test(text)) {
    text = `# Task\n\n${text.replace(/^\s+/, "")}`;
  }
  // 3. Backtick'uojam bare komandas/kelius, kad kanoniniai parseriai juos matytų.
  text = backtickBareBullets(text, "## Patikra", "check");
  text = backtickBareBullets(text, "## Failai", "path");
  // 4-6. Išvedamos HARD sekcijos: tik iš jau esamo task turinio, nieko neišgalvojant.
  text = deriveMissingHardSections(text);
  return text;
}

/**
 * Išveda trūkstamas HARD sekcijas iš jau esamo task turinio. Kiekviena taisyklė
 * konservatyvi: sekcija pridedama tik kai jos turinys VIENAREIKŠMIŠKAI išplaukia iš
 * teksto; priešingu atveju paliekama trūkstama ir sekcijų gate'as parkina kaip anksčiau.
 */
function deriveMissingHardSections(taskText: string): string {
  let text = taskText;
  const tikslas = extractSection(text, "## Tikslas").trim();

  // `## Veiksmas` iš `## Tikslas` bullet/numeruotų punktų; be punktų — vienas bendras
  // bullet, rodantis į Tikslą (veiksmų sąrašo neišgalvojam).
  if (!text.includes("## Veiksmas") && tikslas) {
    const bullets = tikslas
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^(?:[-*]|\d+[.)])\s+\S/.test(line))
      .map((line) => line.replace(/^\d+[.)]\s+/, "- ").replace(/^\*\s+/, "- "));
    const body = bullets.length > 0 ? bullets.join("\n") : "- Įgyvendink `## Tikslas` sekcijoje aprašytą pakeitimą.";
    text = `${text.trimEnd()}\n\n## Veiksmas\n${body}\n`;
  }

  // `## Stop` kanoninis default — tik kai task'as turi realų Tikslą (kitaip jis vis
  // tiek parkinamas ir sintetinis Stop tik maskuotų problemą).
  if (!text.includes("## Stop") && tikslas) {
    text = `${text.trimEnd()}\n\n## Stop\nKai patikros žalios, įrašyk commit žinutę į logs/commit-msg.md ir sustok.\n`;
  }

  // `## Spec source` iš inline nuorodos: openspec change arba architecture-node.
  if (!text.includes("## Spec source")) {
    const specRef =
      text.match(/\b(?:AG\/)?openspec\/changes\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]*)?/)?.[0] ??
      text.match(/\barchitecture-node\/[A-Za-z0-9._-]+/)?.[0];
    if (specRef) {
      text = `${text.trimEnd()}\n\n## Spec source\n${specRef}\n`;
    }
  }

  return text;
}

/**
 * Apgaubia backtick'ais bare bullet reikšmes nurodytos antraštės sekcijoje. `check`
 * režimas apgaubia visą bullet turinį (komanda gali turėti tarpų, pvz. `pnpm test`);
 * `path` režimas skaido reikšmę kableliais ir apgaubia tik path-formos tokenus, palikdamas
 * marker/prozines eilutes (`Leidžiama:`, „visi kiti failai") nepaliestas. Jau backtick'uotos
 * eilutės praleidžiamos.
 */
function backtickBareBullets(text: string, heading: string, kind: "check" | "path"): string {
  const lines = text.split(/\r?\n/);
  // Riba — `shared/markdown.findSectionBounds` (2026-08-24, RAG auditas 5). Vietinis ciklas buvo
  // fence-aklas: ```bash blokas su `# ...` eilute nutraukdavo backtick'avimą, ir po jo einančios
  // `## Patikra` komandos preflight'ui likdavo nematomos.
  const bounds = findSectionBounds(lines, (line) => line.trim() === heading);
  if (bounds === undefined) {
    return text;
  }
  for (let i = bounds.start + 1; i < bounds.end; i += 1) {
    const line = lines[i] ?? "";
    const bullet = line.match(/^(\s*[-*]\s+)(.*\S)\s*$/);
    if (!bullet) {
      continue;
    }
    const prefix = bullet[1] ?? "";
    const content = bullet[2] ?? "";
    if (content.includes("`")) {
      continue; // jau backtick'uota
    }
    if (kind === "check") {
      lines[i] = `${prefix}\`${content}\``;
      continue;
    }
    const tokens = content.split(",").map((token) => token.trim()).filter(Boolean);
    const isPathToken = (token: string): boolean => /[/*.]/.test(token) && !/\s/.test(token);
    if (!tokens.some(isPathToken)) {
      continue; // prozinis bullet (pvz. „visi kiti failai") — nepaliesta
    }
    lines[i] = prefix + tokens.map((token) => (isPathToken(token) ? `\`${token}\`` : token)).join(", ");
  }
  return lines.join("\n");
}

/**
 * Suderina claude_task `## Agentai` sekcijos turinį su normalizuota grandine.
 * Vykdytojas paklūsta task teksto `## Agentai`, ne `target_agent_chain`,
 * todėl be šito readme-guard realiai nepaleistų pirmas. Jei sekcijos nėra —
 * tekstas grąžinamas nepakeistas.
 */
export function syncAgentsSection(claudeTask: string, chain: string[]): string {
  if (chain.length === 0 || !claudeTask) {
    return claudeTask;
  }
  const joined = serializeAgentChain(chain);
  // Nuo `## Agentai` antraštės iki kitos `##` antraštės (privalomame formate po
  // `## Agentai` visada eina `## Failai`/`## Veiksmas`, tad lookahead visada suveikia).
  const sectionRe = /(^##\s*Agentai[^\n]*\n)[\s\S]*?(?=\n##)/m;
  if (!sectionRe.test(claudeTask)) {
    return claudeTask;
  }
  return claudeTask.replace(sectionRe, `$1${joined}\n`);
}

// --- Architektūros stiliaus ir enforcement politikos vartai ------------------------------

/** Politikos vaizdas, kurio reikia vartams; loaderių schemos (policy-governance) jį TENKINA. */
export type ArchitectureGatePolicyView = ArchitectureStylePolicy & { strictness: EnforcementLevel };

export type EnforcementGatePolicyView = {
  require_tests_for_code_changes: boolean;
  max_files_per_task: number;
  broad_scope_requires_human_review: boolean;
  require_interface_contract_for_public_changes: boolean;
};

export type PolicyGateInput = {
  taskText: string;
  allowedFiles: string[];
  checks: string[];
  specSources: string[];
  classification: TaskClassification;
  architectureStylePolicy: ArchitectureGatePolicyView;
  enforcementPolicy: EnforcementGatePolicyView;
};

export type PolicyGateResult = {
  /** Fatal: the same task must be blocked (manual) or routed to human review (loop). */
  invalidReasons: string[];
  /** Advisory: flagged for review but never blocks dispatch on its own. */
  reviewReasons: string[];
};

/**
 * Architecture-style and enforcement-policy gates, extracted from `evaluatePreflight` so the
 * production loop preflight can run the exact same rules instead of skipping them entirely
 * (etalono task 873: `block`-strictness pažeidimas buvo `invalid` rankiniame preflight'e, bet
 * loop'as tą patį task'ą tyliai dispatch'indavo).
 */
export function evaluateArchitectureAndPolicyGates(input: PolicyGateInput): PolicyGateResult {
  const { architectureStylePolicy, enforcementPolicy } = input;
  const invalidReasons: string[] = [];
  const reviewReasons: string[] = [];

  if (
    enforcementPolicy.require_tests_for_code_changes &&
    input.classification.categories.some((category) => category !== "routine") &&
    !input.checks.some((check) => /\btest\b|jest|vitest|mocha|spec/i.test(check))
  ) {
    invalidReasons.push("require_tests_for_code_changes: no test command found in checks");
  }

  // Trijų pakopų įrodymų modelis (žr. domain/policies/architecture-style.ts):
  // evidence=confirmed seka sukonfigūruotą griežtumą kaip yra (warn→review, block→block);
  // evidence=possible visada nužeminamas iki review, net esant block griežtumui — dalinis
  // tekstinis signalas neturi kietai numušti task'o.
  if (architectureStylePolicy.strictness !== "advisory") {
    for (const violation of detectForbiddenDependencyViolations(architectureStylePolicy, input.allowedFiles, {
      taskText: input.taskText,
    })) {
      const verdict = decideEnforcement(architectureStylePolicy.strictness, violation.evidence);
      if (verdict.reason_kind === "confirmed") {
        const where = violation.file ?? violation.endpoint;
        const message = `architecture ${architectureStylePolicy.strictness}: forbidden dependency "${violation.dependency}" touched by scope "${where}" (evidence: confirmed)`;
        if (verdict.effect === "block") invalidReasons.push(message);
        else reviewReasons.push(message);
      } else {
        const detail = violation.sources[0] ?? `endpoint "${violation.endpoint}"`;
        reviewReasons.push(
          `architecture possible: forbidden dependency "${violation.dependency}" (evidence: possible; ${detail})`,
        );
      }
    }
  }

  if (input.allowedFiles.length > enforcementPolicy.max_files_per_task) {
    reviewReasons.push(`policy max_files_per_task: ${input.allowedFiles.length} > ${enforcementPolicy.max_files_per_task}`);
  }

  if (enforcementPolicy.broad_scope_requires_human_review) {
    for (const file of input.allowedFiles) {
      if (/^(\*\*|.+\/\*\*)$/.test(file)) {
        reviewReasons.push(`policy broad_scope_requires_human_review: broad path "${file}"`);
      }
    }
  }

  if (enforcementPolicy.require_interface_contract_for_public_changes) {
    const isPublicChange = input.classification.categories.some(
      (category) => category === "architecture" || category === "policy-sensitive" || category === "release",
    );
    if (isPublicChange && !input.specSources.some((source) => /contract|interface|openapi|api[-_]spec/i.test(source))) {
      reviewReasons.push(
        `policy require_interface_contract_for_public_changes: no interface-contract spec source found (sources: ${input.specSources.join(", ")})`,
      );
    }
  }

  return { invalidReasons, reviewReasons };
}
