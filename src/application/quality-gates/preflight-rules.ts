// Preflight taisyklių GRYNOJI pusė: sekcijų taksonomija, source-change šablonas, backtick patikrų parseris,
// verdiktų/normalizavimo taisyklės, architektūros/enforcement vartai ir frontmatter split. Etalone
// `evaluateArchitectureAndPolicyGates` pats skaitė policy failus; čia GRYNAS — politikas paduoda kvietėjas.

import { extractSection, findSectionBounds, markdownFenceMask, splitLines } from "../../shared/markdown.js";
import { allowedPaths, matchesAllowedPath } from "../../domain/tasks/allowed-paths.js";
import { serializeAgentChain } from "../../domain/policies/agent-selection.js";
import { detectForbiddenDependencyViolations, type ArchitectureStylePolicy } from "../../domain/policies/architecture-style.js";
import { decideEnforcement, type EnforcementLevel } from "../../domain/policies/enforcement-level.js";
import type { TaskClassification } from "../../domain/policies/task-classification.js";

// `claude_task` sekcijų taksonomija, bendra manual preflight ir loop normalizeriui.
// CORE: struktūriškai privalomos visur — nėra atstatymo kelio, jei jų trūksta.
export const CORE_REQUIRED_SECTIONS = ["# Task", "## Spec source", "## Tikslas", "## Veiksmas", "## Stop"];
// SCOPED: privalomos pilnam task'ui; loop'o LLM reformulacija dar gali pridėti trūkstamą.
export const SCOPED_REQUIRED_SECTIONS = ["## Agentai", "## Failai", "## Patikra"];
// INFORMATIONAL: never fatal anywhere.
export const INFORMATIONAL_SECTIONS = ["## Neįtraukta"];
export const ALL_REQUIRED_HEADINGS = [...CORE_REQUIRED_SECTIONS, ...SCOPED_REQUIRED_SECTIONS];

// Safe default source-directory conventions the source-change gate always recognizes, even with no project
// profile. Purely additive prefiksų aibė (task 888).
const DEFAULT_SOURCE_CHANGE_PREFIXES = [
  "apps", "modules", "packages", "workers", "internal", "cmd", "lib", "pkg", "app", "services", "src",
];

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the source-change detection pattern from the safe defaults above plus any project profile `source_roots`
 * (task 888): a custom-named root (e.g. a bare `frontend/`) is folded in by its first path segment.
 * `AG/orchestrator/` lieka fiksuotas atvejis — AG-formos target projekto elgesio paritetui.
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
 * `## Patikra` sekcijos backtick patikros — vienintelis eksportuotas parseris, naudojamas ir manual preflight,
 * ir context-pack (worker-task-ir), ir production-loop preflight. context-pack traktuoja tuščias patikras kaip
 * "Malformed task"; be šio patikrinimo LLM reformuluotas claude_task su tuščiu `## Patikra` praeidavo preflight
 * ir dispatch metu context-pack krisdavo (task 872). */
export function parseBacktickChecks(taskText: string | undefined): string[] {
  // FENCED blokai praleidžiami, skenuojama PO EILUTĖS (RAG auditas 5): anksčiau fence ribos pačios atrodydavo kaip
  // backtick span'ai, ir TIKRA komanda po ```` ``` ```` bloko būdavo suvalgyta uždarančio fence backtick'ų.
  // Po eilutės — nes patikra yra VIENA komanda.
  const lines = splitLines(extractSection(taskText ?? "", "## Patikra"));
  const fenced = markdownFenceMask(lines);
  return lines
    .flatMap((line, index) =>
      fenced[index] === true ? [] : Array.from(line.matchAll(/`([^`]+)`/g), (match) => (match[1] ?? "").trim()),
    )
    .filter(Boolean);
}

// --- Production-loop preflight normalization rules ---------------------------
// Pure verdict/section/normalization rules for the loop preflight, anchored to the CORE/SCOPED/INFORMATIONAL
// taxonomy above. Bendra taksonomija dar NĖRA bendras atsakymas: iki 2026-09-05 loop'as sekcijas tikrino
// substring'u (`## Tasks` tenkino `# Task`), o manual preflight — tikslia eilute, tad tas pats task'as gaudavo
// du skirtingus verdiktus. Dabar abu skaito {@link hasHeadingLine} — TIK tada „negali išsiskirti" yra tiesa.

// HARD = CORE (no recovery path). SOFT = advisory; loop's LLM reformulation can add a missing one, so absence
// must never hard-block a task to human-review.
export const HARD_SECTIONS = CORE_REQUIRED_SECTIONS;
export const SOFT_SECTIONS = [...SCOPED_REQUIRED_SECTIONS, ...INFORMATIONAL_SECTIONS];

// ALREADY_IMPLEMENTED/AUDIT_COMPLETE markeriai priimami vietoj naujo commit'o (2026-06-11 auditas). Sandbox
// komandos yra ĮVESTIS (VQ-703): agentui duota komanda, kurios projekte nėra, sudegina turns blogiau nei
// jokia — todėl šaltinis yra kokybės politika, ne tekstas.
export type VerificationCommands = {
  /** Kanoninė perstatymo komanda (`DIST_REBUILD_COMMAND`). */
  rebuild: string;
  /** Patikros, kurias projektas realiai deklaruoja (`quality-policy` scope komandos). */
  checks: readonly string[];
};

export function verificationPreamble(commands: VerificationCommands): string {
  const checks = commands.checks.length > 0 ? commands.checks : [commands.rebuild];
  return `## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO \`src\` pakeitimo \`dist\` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: \`${commands.rebuild}\`
- Patikroms naudok tik: ${checks.map((check) => `\`${check}\``).join(" ir ")} (be \`--\`, be pipe į kitas komandas).
- \`echo\`, \`sed\`, \`node -e\` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). \`## Agentai\` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

`;
}

// Antraštės, kurias `verificationPreamble` gali įterpti task'o pradžioje. Prefiksas, ne tiksli eilutė —
// antraštės neša laisvus sufiksus (plg. `worker-task-ir` DIRECTIVE_HEADING_PREFIXES).
const VERIFICATION_PREAMBLE_HEADING_PREFIXES: readonly string[] = ["## Žingsnis 0", "## Sandbox taisyklės"];

const FRONTMATTER_FENCE = "---";

export type FrontmatterSplit = { frontmatter: string; body: string };

/** Atskiria vedantį `---`...`---` frontmatter bloką (task 149), be YAML parserio — tik ribos.
 * `---` vėliau tekste nelaikoma frontmatter'iu. `frontmatter + body === taskText` visada. */
export function splitLeadingFrontmatter(taskText: string): FrontmatterSplit {
  const original = taskText ?? "";
  const lines = splitLines(original);
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") {
    index += 1;
  }
  if ((lines[index] ?? "").trim() !== FRONTMATTER_FENCE) {
    return { frontmatter: "", body: original };
  }
  for (let closeIndex = index + 1; closeIndex < lines.length; closeIndex += 1) {
    if ((lines[closeIndex] ?? "").trim() !== FRONTMATTER_FENCE) {
      continue;
    }
    const hasBody = closeIndex + 1 < lines.length;
    const frontmatter = lines.slice(0, closeIndex + 1).join("\n") + (hasBody ? "\n" : "");
    const body = hasBody ? lines.slice(closeIndex + 1).join("\n") : "";
    return { frontmatter, body };
  }
  return { frontmatter: "", body: original };
}

/**
 * Nuima VEDANČIUS `## Žingsnis 0` / `## Sandbox taisyklės` blokus iš task teksto pradžios; vėlesnis pasikartojimas
 * (po `# Task`, fenced pavyzdyje) lieka nepaliestas. Vedantis frontmatter'is (task 149) pirma atskiriamas per
 * {@link splitLeadingFrontmatter} ir grąžinamas priešais nuluptą kūną — kitaip dingtų kartu su preambule. */
export function stripVerificationPreamble(taskText: string): string {
  const original = taskText ?? "";
  const { frontmatter, body } = splitLeadingFrontmatter(original);
  let lines = splitLines(body);
  let stripped = false;
  for (;;) {
    let leadIndex = 0;
    while (leadIndex < lines.length && (lines[leadIndex] ?? "").trim() === "") {
      leadIndex += 1;
    }
    const leadLine = (lines[leadIndex] ?? "").trim();
    if (!VERIFICATION_PREAMBLE_HEADING_PREFIXES.some((prefix) => leadLine.startsWith(prefix))) {
      break;
    }
    const bounds = findSectionBounds(lines, (line) =>
      VERIFICATION_PREAMBLE_HEADING_PREFIXES.some((prefix) => line.trim().startsWith(prefix)),
    );
    if (bounds === undefined || bounds.start !== leadIndex) {
      break;
    }
    lines = lines.slice(bounds.end);
    stripped = true;
  }
  return stripped ? `${frontmatter}${lines.join("\n")}` : original;
}

/**
 * Kanoninis sekcijos antraštės matcher'is: TIKSLI trim'inta eilutė, ne substring — `## Tasks` turi `# Task`,
 * `## Stop condition` turi `## Stop`, o fenced pavyzdys `# Task <pavadinimas>` atrodo kaip tikra antraštė. Vienas
 * skaitytojas abiem keliams: loop'o {@link missingTaskSections} ir manual preflight (QG-2, 2026-09-05). */
export function hasHeadingLine(text: string | undefined, heading: string): boolean {
  return (text ?? "").split(/\r?\n/).some((line) => line.trim() === heading);
}

export function missingTaskSections(task: string | undefined): { hard: string[]; soft: string[] } {
  const content = task ?? "";
  return {
    hard: HARD_SECTIONS.filter((s) => !hasHeadingLine(content, s)),
    soft: SOFT_SECTIONS.filter((s) => !hasHeadingLine(content, s)),
  };
}

/**
 * True only when claude_task omits a MANDATORY (HARD) section. Missing advisory (SOFT) sections are NOT fatal:
 * the normalizing LLM that rewrites the task non-deterministically drops a trailing advisory section (most often
 * ## Neįtraukta), and that must never park an otherwise valid task to human-review.
 */
export function hasFatalSectionGap(task: string | undefined): boolean {
  return missingTaskSections(task).hard.length > 0;
}

/**
 * True when a preflight decision carries no verdict (missing/blank). An empty verdict signals a malformed or empty
 * LLM response — almost always a transient API condition rather than a deliberate decision — so it must be
 * retried/left in queue, not parked to human-review.
 */
export function isEmptyVerdict(decision: { verdict?: string } | undefined): boolean {
  return (decision?.verdict ?? "") === "";
}

/**
 * True when a delegate/reformulate_delegate decision's `claude_task` has zero parseable `## Patikra` backtick
 * checks (task 926 — corrective retry instead of generic human-review). `human_review`/`reject` decisions are
 * exempt: they never dispatch a claude_task, so an empty ## Patikra there is not a defect.
 */
export function needsPatikraChecksRetry(decision: { verdict?: string; claude_task?: string } | undefined): boolean {
  const verdict = decision?.verdict ?? "";
  if (verdict !== "delegate" && verdict !== "reformulate_delegate") {
    return false;
  }
  return parseBacktickChecks(decision?.claude_task).length === 0;
}

/**
 * readme-guard PRIVALO būti pirmas source-change task'o grandinėje: jis perskaito README ir jo Read hook įrašo
 * įrodymą, be kurio pre-write hook blokuoja source edits. LLM nepatikimai jį prideda, todėl normalizuojame
 * deterministiškai — įterpiame priekyje, pašalindami galimą dublį toliau grandinėje. Tuščia arba jau teisinga
 * grandinė grąžinama nepakeista.
 */
export function ensureReadmeGuardFirst(chain: string[]): string[] {
  if (chain.length === 0 || chain[0] === "readme-guard") {
    return chain;
  }
  return ["readme-guard", ...chain.filter((agent) => agent !== "readme-guard")];
}

/**
 * Deterministinis legacy/near-kanoninių sekcijų normalizavimas, taikomas loop'o preflight PRIEŠ bet kokį gate'ą
 * (task 882). Suvedžia žinomas legacy formas į kanoninę taksonomiją, kad tas pats task'as praeitų sekcijų ir
 * patikrų gate'us ir būtų deleguotas. NEkeičia užduoties prasmės — tik antraštes ir backtick formatavimą; jau
 * kanoninis tekstas grąžinamas nepakeistas. `## Tikslas` niekada nesintetinamas. */
export function normalizeLegacyTaskSections(taskText: string | undefined): string {
  let text = taskText ?? "";
  // 1. Legacy antraščių pervadinimas (eilutės pradžia, label case-insensitive).
  text = text.replace(/^(#{2,3})[ \t]+Reikalavimai[ \t]*$/gim, "## Veiksmas");
  text = text.replace(/^(#{2,3})[ \t]+Stop[ \t]+condition[ \t]*$/gim, "## Stop");
  // 2. Kanoninis `# Task` (HARD). Sąlyga skaito TĄ PATĮ matcher'į kaip gate'as: kitaip `# Task 183: foo`
  // normalizatoriui atrodytų kaip antraštė, gate'ui — ne, ir task'as parkuotųsi.
  if (!hasHeadingLine(text, "# Task")) {
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
 * Išveda trūkstamas HARD sekcijas iš jau esamo task turinio. Kiekviena taisyklė konservatyvi: sekcija pridedama tik
 * kai jos turinys VIENAREIKŠMIŠKAI išplaukia iš teksto; kitaip lieka trūkstama ir sekcijų gate'as parkina.
 */
function deriveMissingHardSections(taskText: string): string {
  let text = taskText;
  const tikslas = extractSection(text, "## Tikslas").trim();

  // `## Veiksmas` iš `## Tikslas` bullet/numeruotų punktų; be punktų — vienas bendras bullet, rodantis į Tikslą
  // (veiksmų sąrašo neišgalvojam).
  if (!hasHeadingLine(text, "## Veiksmas") && tikslas) {
    const bullets = tikslas
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^(?:[-*]|\d+[.)])\s+\S/.test(line))
      .map((line) => line.replace(/^\d+[.)]\s+/, "- ").replace(/^\*\s+/, "- "));
    const body = bullets.length > 0 ? bullets.join("\n") : "- Įgyvendink `## Tikslas` sekcijoje aprašytą pakeitimą.";
    text = `${text.trimEnd()}\n\n## Veiksmas\n${body}\n`;
  }

  // `## Stop` kanoninis default — tik kai task'as turi realų Tikslą (kitaip jis vis tiek parkinamas ir sintetinis
  // Stop tik maskuotų problemą).
  if (!hasHeadingLine(text, "## Stop") && tikslas) {
    text = `${text.trimEnd()}\n\n## Stop\nKai patikros žalios, įrašyk commit žinutę į vq/logs/commit-msg.md ir sustok.\n`;
  }

  // `## Spec source` iš inline nuorodos: openspec change arba architecture-node.
  if (!hasHeadingLine(text, "## Spec source")) {
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
 * Apgaubia backtick'ais bare bullet reikšmes nurodytos antraštės sekcijoje. `check` režimas apgaubia visą bullet
 * turinį (komanda gali turėti tarpų, pvz. `pnpm test`); `path` režimas skaido reikšmę kableliais ir apgaubia tik
 * path-formos tokenus, palikdamas marker/prozines eilutes (`Leidžiama:`, „visi kiti failai") nepaliestas. Jau
 * backtick'uotos eilutės praleidžiamos.
 */
function backtickBareBullets(text: string, heading: string, kind: "check" | "path"): string {
  const lines = text.split(/\r?\n/);
  // Riba — `shared/markdown.findSectionBounds` (2026-08-24, RAG auditas 5). Vietinis ciklas buvo fence-aklas:
  // ```bash blokas su `# ...` eilute nutraukdavo backtick'avimą, ir po jo einančios komandos likdavo nematomos.
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
 * Suderina claude_task `## Agentai` sekcijos turinį su normalizuota grandine. Vykdytojas paklūsta task teksto
 * `## Agentai`, ne `target_agent_chain`, todėl be šito readme-guard realiai nepaleistų pirmas. Jei sekcijos
 * nėra — tekstas grąžinamas nepakeistas.
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

// Zondo segmentas, kurio realiame kelyje nebūna: jis atstoja wildcard'ą ir `x/` katalogo vaiką.
const BROAD_SCOPE_PROBE = "__vq_broad_probe__";

/**
 * True, kai leidžiamas kelias per {@link matchesAllowedPath} dengia KATALOGĄ, o ne konkretų failą: `**`, `x/**`,
 * `x/` (brūkšnys gale), `x/*`, `x/a/*.ts` ir gilus glob'as su plėtiniu gale. Sprendžia TA PATI funkcija, kuria
 * vėliau tikrinama reali rašymo riba, tad vartas ir matcher'is išsiskirti negali (iki 2026-09-05 čia buvo atskiras
 * regex'as, mates tik `**` ir `x/**`, ir `Leidžiama: src/` praeidavo, nors dengia visą medį). Metodas: iš paties
 * kelio konstruojamas ZONDAS (wildcard'ai → konkretus segmentas, `x/` → vaikas), ir kelias platus tik tada, kai
 * matcher'is zondą priima, nors kelias jo NEĮVARDIJA — todėl `src/index.ts` ir `Dockerfile` lieka siauri.
 * Etalono `isWildcardPath` (`domain/tasks/etalonas-rules`) mato siauresnę aibę ir reikalauja TIK pagrindimo tekste;
 * šis vartas parkuoja į human-review. Tyčia: etalonas tikrina task'o FORMĄ rašymo metu, o
 * `enforcementPolicy.broad_scope_requires_human_review` — LEIDIMO DYDĮ prieš dispatch'ą. */
function isBroadScopePath(allowedPath: string): boolean {
  const value = allowedPath.trim().replace(/\\/g, "/");
  if (value === "") return false;
  const probe = (value.endsWith("/") ? `${value}${BROAD_SCOPE_PROBE}` : value)
    .replace(/\*\*\//g, "")
    .replace(/\*+/g, BROAD_SCOPE_PROBE);
  return probe !== value && matchesAllowedPath(probe, value);
}

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
 * Architecture-style and enforcement-policy gates, extracted from `evaluatePreflight` so the production loop
 * preflight can run the exact same rules instead of skipping them entirely (etalono task 873: `block`-strictness
 * pažeidimas buvo `invalid` rankiniame preflight'e, bet loop'as tą patį task'ą tyliai dispatch'indavo). */
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

  // Trijų pakopų įrodymų modelis (žr. domain/policies/architecture-style.ts): evidence=confirmed seka
  // sukonfigūruotą griežtumą kaip yra (warn→review, block→block); evidence=possible visada nužeminamas iki
  // review, net esant block griežtumui — dalinis tekstinis signalas neturi kietai numušti task'o.
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
      if (isBroadScopePath(file)) {
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

// --- Hallucinated allowed-path detection --------------------------------------------------

/** Tėvinis katalogas, arba `undefined` root-level failui/katalogui (tikrinti nėra ko). */
function parentDirectoryOf(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? undefined : normalized.slice(0, idx);
}

/**
 * `## Failai` → `Leidžiama:` keliai, kurių TĖVINIS KATALOGAS neegzistuoja — ĮRODYTAI sugalvotas kelias, ne tik dar
 * nesamas failas esamame kataloge. `dirExists` yra injektuojamas predikatas (jokio `node:fs` čia — application
 * sluoksnis lieka grynas). Glob'ai (`**`, `*`) ir root-level keliai (be tėvinio katalogo) fail-open praleidžiami:
 * abejotinas kelias paliekamas leidžiamas. Platumo (broad scope) ribą sprendžia {@link isBroadScopePath}.
 */
export function detectHallucinatedAllowedPaths(taskText: string, dirExists: (dir: string) => boolean): string[] {
  const flagged: string[] = [];
  for (const path of allowedPaths(taskText)) {
    if (path.includes("*")) continue;
    const parent = parentDirectoryOf(path);
    if (parent === undefined) continue;
    if (!dirExists(parent)) {
      flagged.push(path);
    }
  }
  return flagged;
}
