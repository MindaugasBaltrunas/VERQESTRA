// Pure structural validator mirroring `AG/tasks/examples/000-etalonas.md`. This is the shared
// core: the pre-write hook and the 070 preflight gate both import `validateTaskAgainstEtalonas`
// instead of keeping their own copy of "what does a conforming task file look like". Structure
// only — whether the prose under a section actually ANSWERS it is the preflight LLM's job, not
// this one. `domain` layer: no filesystem, no clock, so the set of task ids a `## Priklausomybės`
// reference may point at arrives as a plain argument, never read from disk here.

import { enumerateTaskSections, normalizeTaskHeading, taskBulletItems, type TaskSection } from "./sections.js";
import { allowedPaths, forbiddenPaths } from "./allowed-paths.js";
import { isPlaceholderDependency } from "./dependencies.js";
import { parseAgentChain } from "../policies/agent-selection.js";

const ETALONAS_PATH = "AG/tasks/examples/000-etalonas.md";

export type Violation = {
  /** Stable machine key for the broken rule, e.g. "mandatory-section-missing". */
  ruleId: string;
  /** Heading (or label) of the section the violation belongs to. */
  section: string;
  /** Human-readable explanation, always pointing back at the etalon file. */
  message: string;
  /** Verbatim etalon citation naming the violated rule, when the rule quotes one. */
  citation?: string;
  /** Concrete finding (path/line) in THIS task backing the violation. */
  detail?: string;
};

type CanonicalSection = {
  label: string;
  mandatory: boolean;
  matches: (key: string) => boolean;
};

/**
 * Section order as `AG/tasks/examples/000-etalonas.md` defines it. `## Priklausomybės` and
 * `## Žingsnis 0` are optional (real tasks like 071 and 071-a-02 omit both) — everything else
 * is mandatory. Rank in this array IS the etalon order; a recognized section appearing before
 * one of lower rank is a `mandatory-section-order` violation.
 */
const CANONICAL_ORDER: readonly CanonicalSection[] = [
  { label: "## Spec source", mandatory: true, matches: (key) => key === "spec source" },
  { label: "## Priklausomybės", mandatory: false, matches: (key) => key === "priklausomybes" },
  {
    label: "## Žingsnis 0 — ar jau įgyvendinta?",
    mandatory: false,
    matches: (key) => key.startsWith("zingsnis 0"),
  },
  { label: "## Tikslas", mandatory: true, matches: (key) => key === "tikslas" },
  { label: "## Agentai", mandatory: true, matches: (key) => key === "agentai" },
  { label: "## Failai", mandatory: true, matches: (key) => key === "failai" },
  { label: "## Veiksmas", mandatory: true, matches: (key) => key === "veiksmas" },
  { label: "## Patikra", mandatory: true, matches: (key) => key === "patikra" },
  { label: "## Stop", mandatory: true, matches: (key) => key === "stop" },
  { label: "## Neįtraukta", mandatory: true, matches: (key) => key === "neitraukta" },
];

/** The only `## Patikra` command forms the sandbox accepts (see etalon comment on the section). */
const ALLOWED_PATIKRA_COMMANDS: readonly string[] = ["pnpm build", "pnpm test", "pnpm --dir ui-app build"];

/** Shape of a real task id (`071-a-02-...`, `073-registraciju-...`) — never brackets or prose. */
const TASK_ID_SHAPE = /^[0-9]{2,4}(-[a-z0-9]+)+$/;

const BULLET_LINE = /^\s*[-*]\s+\S/;
const BACKTICK_PATH = /`([^`]+)`/;

/** Bullet forma, kuria `allowed-paths.ts` `foldLogicalEntries` pradeda NAUJĄ loginį įrašą. */
const ENTRY_BULLET = /^\s*[-*+]\s/;

/** Etalono `<pilnas-task-id-be-md>` šablonas: vienintelė ne-id `## Priklausomybės` išimtis. */
const DEPENDENCY_TEMPLATE = /^<.+>$/;

/** Etalono ## Failai (9): `CONTEXT_CACHE_VERSION` kėlimas VISADA pina šiuos du testus. */
const CACHE_VERSION_PIN_TESTS: readonly string[] = [
  "src/tests/context-pack-guards.test.ts",
  "src/tests/context-pack-code-index-identity.test.ts",
];
const CACHE_VERSION_TOKEN = /CONTEXT_CACHE_VERSION/;

/** Backend production file marker (`.ts`/`.tsx`/`.js`/`.jsx`, optional `m`/`c` prefix). */
const SOURCE_FILE_EXTENSION = /\.(m|c)?[jt]sx?$/i;
const TEST_LIKE_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR_SEGMENT = /(^|\/)tests?(\/|$)/i;

const I18N_CONTEXT_PATH = "ui-app/src/i18n/I18nContext.tsx";
const DASHBOARD_STYLE_DIR = "ui-app/src/view/styles/";

function violation(
  ruleId: string,
  section: string,
  message: string,
  extra?: { citation?: string; detail?: string },
): Violation {
  return {
    ruleId,
    section,
    message: `${message} (žr. ${ETALONAS_PATH}).`,
    ...(extra?.citation !== undefined ? { citation: extra.citation } : {}),
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
  };
}

/**
 * VIENA wildcard apibrėžimo vieta: katalogo/apimties kelias, ne konkretus failas. Naudojama
 * ir `## Failai` pagrindimo taisyklei (rule 2), ir produkcinio-failo/testo poros taisyklei —
 * anksčiau preflight-fastpath.ts turėjo antrą, siauresnę kopiją (`!path.includes("*")").
 */
function isWildcardPath(path: string): boolean {
  return path.includes("**") || path.endsWith("/");
}

function isTestLikePath(path: string): boolean {
  return TEST_LIKE_FILE.test(path) || TEST_DIR_SEGMENT.test(path);
}

/** Backend produkcinis failas (`src/**`, ne `ui-app/**`) — konkretus, ne testas, ne wildcard'as. */
function isBackendProductionFile(path: string): boolean {
  return (
    path.startsWith("src/") &&
    !path.startsWith("ui-app/") &&
    !isWildcardPath(path) &&
    SOURCE_FILE_EXTENSION.test(path) &&
    !isTestLikePath(path)
  );
}

/** UI komponento/puslapio failas — ne pats I18nContext, ne testas. */
function isUiComponentFile(path: string): boolean {
  return path.startsWith("ui-app/") && path.endsWith(".tsx") && path !== I18N_CONTEXT_PATH && !isTestLikePath(path);
}

/** Bet kuris dashboard'o stilių failas (žr. preflight-fastpath.ts istoriją: 2026-09-03 skaidymas). */
function isDashboardStylePath(path: string): boolean {
  return path.startsWith(DASHBOARD_STYLE_DIR) && path.endsWith(".css");
}

function findSection(sections: readonly TaskSection[], matches: (key: string) => boolean): TaskSection | undefined {
  return sections.find((section) => section.key !== "" && matches(section.key));
}

/**
 * Presence AND order of every canonical section. Missing optional sections are fine; a
 * recognized section appearing out of etalon order is not, even if every section is present.
 */
function checkMandatorySectionsOrder(sections: readonly TaskSection[]): Violation[] {
  const violations: Violation[] = [];
  const foundRanks = new Set<number>();
  let lastRank = -1;
  let lastLabel = "";

  for (const section of sections) {
    if (!section.key) continue;
    const rank = CANONICAL_ORDER.findIndex((entry) => entry.matches(section.key));
    if (rank === -1) continue;
    foundRanks.add(rank);
    if (rank < lastRank) {
      violations.push(
        violation(
          "mandatory-section-order",
          section.heading,
          `Sekcija "${section.heading}" eina po "${lastLabel}", bet etalone jų tvarka priešinga`,
        ),
      );
      continue;
    }
    lastRank = rank;
    lastLabel = section.heading;
  }

  CANONICAL_ORDER.forEach((entry, rank) => {
    if (entry.mandatory && !foundRanks.has(rank)) {
      violations.push(violation("mandatory-section-missing", entry.label, `Trūksta privalomos sekcijos "${entry.label}"`));
    }
  });

  return violations;
}

/** Visos eilutės TARP `Leidžiama:` ir `Draudžiama:` žymeklių, verbatim (žymekliai atmesti). */
function leidziamaBlockLines(body: string): string[] {
  const result: string[] = [];
  let active = false;
  for (const line of body.split(/\r?\n/)) {
    const key = normalizeTaskHeading(line.trim());
    if (key === "leidziama:") {
      active = true;
      continue;
    }
    if (key === "draudziama:") {
      active = false;
      continue;
    }
    if (active) result.push(line);
  }
  return result;
}

/** Bullet lines under the `Leidžiama:` sub-list of `## Failai`, verbatim (not stripped of markers). */
function leidziamaBulletLines(body: string): string[] {
  return leidziamaBlockLines(body)
    .filter((line) => BULLET_LINE.test(line))
    .map((line) => line.trim());
}

/** `## Failai / Leidžiama` backtick keliai (pirmas backtick tokenas kiekviename bullet'e). */
function leidziamaPaths(failaiSection: TaskSection): string[] {
  const paths: string[] = [];
  for (const line of leidziamaBulletLines(failaiSection.body)) {
    const match = BACKTICK_PATH.exec(line);
    const path = match?.[1];
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * A directory wildcard (`src/tests/**`, `components/`) under `## Failai / Leidžiama` without a
 * justification on the same bullet line. `Draudžiama` is exempt — `dist/**`/`node_modules/**`
 * are boilerplate there in every task and carry no planning cost.
 */
function checkFailaiWildcards(failaiSection: TaskSection | undefined): Violation[] {
  if (!failaiSection) return [];

  const violations: Violation[] = [];
  for (const line of leidziamaBulletLines(failaiSection.body)) {
    const match = BACKTICK_PATH.exec(line);
    if (!match) continue;
    const path = match[1] ?? "";
    if (!isWildcardPath(path)) continue;
    const matched = match[0] ?? "";
    const justification = line.slice(line.indexOf(matched) + matched.length).trim();
    if (justification.length === 0) {
      violations.push(
        violation(
          "failai-wildcard-without-justification",
          "## Failai",
          `Katalogo wildcard'as "${path}" sekcijoje "Leidžiama:" neturi pagrindimo eilutės šalia`,
        ),
      );
    }
  }
  return violations;
}

/**
 * Ne-bullet eilutė su backtick'ais TARP `Leidžiama:` ir `Draudžiama:`. Kanoninis
 * `allowed-paths.ts` tokenizatorius tokiai eilutei ima VISUS backtick tokenus (bullet'e — tik
 * pirmą), tad `> …` anotacija tyliai virsta „keliais": 101-b-03 (2026-09-03) gavo 8 tikrus + 3
 * iš prozos = 11 ir parkavosi ties `context-budget.max_files: 8`. Įtrauktos tęstinės eilutės
 * NEžymimos — `foldLogicalEntries` jas prilipdo prie bullet'o (ta pati įrašų riba, ne kopija).
 */
function checkFailaiProse(failaiSection: TaskSection | undefined): Violation[] {
  if (!failaiSection) return [];
  const message =
    "Ne-bullet eilutė su backtick'ais tarp `Leidžiama:` ir `Draudžiama:` — kanoninis parseris " +
    "VISUS jos backtick'us paverčia leidžiamais keliais; anotaciją dėk VIRŠ `Leidžiama:`";
  const violations: Violation[] = [];
  let openEntry = false;
  for (const line of leidziamaBlockLines(failaiSection.body)) {
    if (line.trim() === "") {
      openEntry = false;
      continue;
    }
    const isBullet = ENTRY_BULLET.test(line);
    if (openEntry && !isBullet && /^\s/.test(line)) continue;
    openEntry = true;
    if (isBullet || !BACKTICK_PATH.test(line)) continue;
    const detail = line.trim().slice(0, 160);
    violations.push(violation("failai-prose-inside-leidziama", "## Failai", message, { detail }));
  }
  return violations;
}

/**
 * Tas pats kelias ir `Leidžiama:`, ir `Draudžiama:` (101-b-03 turėjo): vykdytojui dviprasmiška,
 * o diagnozė ribą skaičiuoja iš leidžiamų — draudimas lieka be galios. Abu rinkiniai imami
 * KANONINIU parseriu, kad riba reikštų tą patį, ką mato scope vartai.
 */
function checkFailaiPathConflicts(taskMarkdown: string): Violation[] {
  const forbidden = new Set(forbiddenPaths(taskMarkdown));
  if (forbidden.size === 0) return [];
  const violations: Violation[] = [];
  for (const path of new Set(allowedPaths(taskMarkdown))) {
    if (!forbidden.has(path)) continue;
    const message = `Kelias \`${path}\` yra ir "Leidžiama:", ir "Draudžiama:" sąraše — vykdytojui dviprasmiška`;
    violations.push(violation("failai-path-both-allowed-and-forbidden", "## Failai", message, { detail: path }));
  }
  return violations;
}

/** `## Neįtraukta` deklaruota, bet be turinio (trūkstamą gaudo `mandatory-section-missing`). */
function checkNeitraukta(sections: readonly TaskSection[]): Violation[] {
  const section = findSection(sections, (key) => key === "neitraukta");
  if (!section || section.body.trim().length > 0) return [];
  const citation = '000-etalonas.md ## Neįtraukta: "Bent viena eilutė — tuščia sekcija reiškia neapgalvotą apimtį."';
  const message = "## Neįtraukta kūnas tuščias — apimtis neapgalvota";
  return [violation("neitraukta-empty", "## Neįtraukta", message, { citation })];
}

/**
 * `CONTEXT_CACHE_VERSION` paminėtas `## Veiksmas`, o `Leidžiama:` neturi abiejų jį pinančių
 * testų. GRYNAI TEKSTINĖ: nesprendžia, ar kėlimas realiai įvyks — tik ar apie jį kalbantis
 * task'as deklaravo testus, kuriuos vykdytojas neišvengiamai pataisys (138, 2026-09-02:
 * nedeklaruoti pin'ai → „outside allowed paths" → rollback → parkas).
 */
function checkCacheVersionPins(sections: readonly TaskSection[], allowed: readonly string[]): Violation[] {
  const section = findSection(sections, (key) => key === "veiksmas");
  if (!section || !CACHE_VERSION_TOKEN.test(section.body)) return [];
  const declared = new Set(allowed);
  const missing = CACHE_VERSION_PIN_TESTS.filter((testPath) => !declared.has(testPath));
  if (missing.length === 0) return [];
  const detail = missing.join(", ");
  const citation =
    '000-etalonas.md ## Failai (9): "`CONTEXT_CACHE_VERSION` kėlimas VISADA liečia ' +
    '`src/tests/context-pack-code-index-identity.test.ts` ir `src/tests/context-pack-guards.test.ts`."';
  const message = `## Veiksmas mini CONTEXT_CACHE_VERSION, bet "Leidžiama:" neturi pinančių testų: ${detail}`;
  return [violation("cache-version-without-pin-tests", "## Failai", message, { citation, detail })];
}

/**
 * `## Agentai` grandinė privalo prasidėti `readme-guard` — jis vienintelis skaito README ir
 * grąžina ribų santrauką likusiems. Imama PIRMA ne tuščia eilutė; vedantį label'į („Privaloma
 * grandinė: …") nuima pats `parseAgentChain`, tad antros kopijos čia nėra. Tuščia grandinė —
 * preflight'o (`empty agent chain`) reikalas.
 */
function checkAgentaiChain(sections: readonly TaskSection[]): Violation[] {
  const section = findSection(sections, (key) => key === "agentai");
  if (!section) return [];
  const firstLine =
    section.body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const first = parseAgentChain(firstLine)[0];
  if (first === undefined || first === "readme-guard") return [];
  const message = `Grandinė prasideda "${first}", o etalone pirmas visada readme-guard`;
  return [violation("agentai-readme-guard-not-first", "## Agentai", message, { detail: firstLine.slice(0, 160) })];
}

/**
 * `## Failai` turi bent vieną konkretų backend produkcinį failą, bet nė vieno testo kelio —
 * etalono ## Failai (2) pažeidimas. Perkelta iš preflight-fastpath.ts (070-a-02) 156-a task'u,
 * kuris suvienodino wildcard apibrėžimą su rule 2 (`isWildcardPath`).
 */
function evaluateProductionFileTestRule(paths: readonly string[]): Violation[] {
  const hasBackendProductionFile = paths.some(isBackendProductionFile);
  const hasTestLikePath = paths.some(isTestLikePath);
  if (!hasBackendProductionFile || hasTestLikePath) return [];
  return [
    violation("production-file-without-test", "## Failai", "## Failai turi produkcinį src/** failą, bet nė vieno testo kelio sąraše", {
      citation:
        "000-etalonas.md ## Failai (2): \"KIEKVIENAS produkcinis failas ateina su savo testo failu " +
        'sąraše. Nežinai vardo — įrašyk numatomą su išlyga... klaidingas konkretus kelias pastebimas, ' +
        'wildcard\'as — ne."',
      detail: "## Failai turi produkcinį src/** failą, bet nė vieno testo kelio sąraše",
    }),
  ];
}

/**
 * `## Failai` turi UI komponento (`.tsx`) failą, bet praleidžia I18nContext'ą ir/ar dashboard'o
 * CSS failą — etalono ## Failai (3) pažeidimas. Perkelta iš preflight-fastpath.ts (070-a-02).
 */
function evaluateUiCoverageRule(paths: readonly string[]): Violation[] {
  if (!paths.some(isUiComponentFile)) return [];
  const citation =
    "000-etalonas.md ## Failai (3): \"UI task'as VISADA įtraukia `ui-app/src/i18n/I18nContext.tsx` " +
    "(nauji tekstai) ir bent vieną `ui-app/src/view/styles/*.css` (naujos className — CSS " +
    'dengiamumo vartas)."';
  const violations: Violation[] = [];
  if (!paths.includes(I18N_CONTEXT_PATH)) {
    violations.push(
      violation("ui-file-without-i18n-context", "## Failai", `## Failai turi UI komponentą, bet ne \`${I18N_CONTEXT_PATH}\``, {
        citation,
        detail: `## Failai turi UI komponentą, bet ne \`${I18N_CONTEXT_PATH}\``,
      }),
    );
  }
  if (!paths.some(isDashboardStylePath)) {
    violations.push(
      violation(
        "ui-file-without-dashboard-css",
        "## Failai",
        `## Failai turi UI komponentą, bet nė vieno \`${DASHBOARD_STYLE_DIR}*.css\``,
        { citation, detail: `## Failai turi UI komponentą, bet nė vieno \`${DASHBOARD_STYLE_DIR}*.css\`` },
      ),
    );
  }
  return violations;
}

/**
 * `## Priklausomybės` bullets: a placeholder (`none`/`-`/`TBD`, {@link isPlaceholderDependency})
 * is forbidden outright, anything shaped like a task id must resolve inside `knownTaskIds`, and
 * everything else — prose — is `priklausomybe-not-a-task-id`. Etalonas: „arba tikras id, arba
 * sekcijos nėra"; vienintelė išimtis — paties etalono `<…>` šablonas. Iki 2026-09-03 proza buvo
 * „left alone": `- 137 pirmoji dalis: …` praeidavo abu validatorius, o `parseTaskDependencies`
 * ją normalizuodavo į niekada neegzistuosiantį id (16 `gate:missing-dependency` eilučių,
 * `LOOP STOP: all-blocked` 09-03 09:51). `knownTaskIds === undefined` tikrina TIK id formą.
 */
function checkPriklausomybes(sections: readonly TaskSection[], knownTaskIds: readonly string[] | undefined): Violation[] {
  const section = findSection(sections, (key) => key === "priklausomybes");
  if (!section) return [];

  const known = knownTaskIds === undefined ? undefined : new Set(knownTaskIds);
  const citation =
    '000-etalonas.md ## Priklausomybės: "Placeholder\'iai („none", „-") draudžiami — arba tikras id, arba sekcijos nėra."';
  const violations: Violation[] = [];
  for (const item of taskBulletItems(section.body)) {
    const trimmed = item.trim();
    if (isPlaceholderDependency(trimmed)) {
      const message = `Placeholder "${trimmed}" draudžiamas — arba tikras task id, arba sekcijos nėra`;
      violations.push(violation("priklausomybe-placeholder", "## Priklausomybės", message));
      continue;
    }
    if (DEPENDENCY_TEMPLATE.test(trimmed)) continue;
    if (!TASK_ID_SHAPE.test(trimmed)) {
      const detail = trimmed.slice(0, 160);
      const message = `Priklausomybė "${detail}" nėra task id — arba tikras id, arba sekcijos nėra`;
      violations.push(violation("priklausomybe-not-a-task-id", "## Priklausomybės", message, { citation, detail }));
      continue;
    }
    if (known !== undefined && !known.has(trimmed)) {
      const message = `Priklausomybė "${trimmed}" nerasta tarp žinomų task id (jokiame bucket'e)`;
      violations.push(violation("priklausomybe-unknown-id", "## Priklausomybės", message));
    }
  }
  return violations;
}

/**
 * `## Patikra` bullets: bent viena backtick komanda (perkelta iš preflight-fastpath.ts
 * `patikra-without-backtick-check`, 070-a-02), ir kiekviena esanti komanda — sandbox-safe
 * leistinos formos. Tuščia sekcija paliekama kitiems vartams (mandatory-section-missing).
 */
function checkPatikra(sections: readonly TaskSection[]): Violation[] {
  const section = findSection(sections, (key) => key === "patikra");
  if (!section) return [];
  if (section.body.trim().length === 0) return [];

  const items = taskBulletItems(section.body);
  if (!items.some((item) => BACKTICK_PATH.test(item))) {
    return [
      violation("patikra-without-backtick-check", "## Patikra", "## Patikra neturi nė vienos backtick komandos", {
        citation:
          '000-etalonas.md ## Patikra: patikros komandos visada rašomos backtick formatu ' +
          "(`pnpm build`, `pnpm test`) — be backtick'ų diagnose/context-pack jų nemato.",
        detail: "## Patikra neturi nė vienos backtick komandos",
      }),
    ];
  }

  const allowedList = ALLOWED_PATIKRA_COMMANDS.join(", ");
  const violations: Violation[] = [];
  for (const item of items) {
    const command = item.trim().replace(/^`|`$/g, "").trim();
    if (!ALLOWED_PATIKRA_COMMANDS.includes(command)) {
      violations.push(
        violation("patikra-unknown-command", "## Patikra", `Komanda "${command}" nėra leistinų formų (${allowedList})`),
      );
    }
  }
  return violations;
}

/**
 * All etalon-structure violations of a task Markdown, in rule order. Empty result means the
 * document's SHAPE conforms to `AG/tasks/examples/000-etalonas.md` — it says nothing about
 * whether the content is any good, which is the preflight LLM gate's job.
 *
 * `knownTaskIds` omitted (`undefined`) skips id-resolution (`priklausomybe-unknown-id`) —
 * callers with no task universe available still get every other rule.
 */
export function validateTaskAgainstEtalonas(text: string, knownTaskIds?: readonly string[]): Violation[] {
  const sections = enumerateTaskSections(text);
  const failaiSection = findSection(sections, (key) => key === "failai");
  const failaiPaths = failaiSection ? leidziamaPaths(failaiSection) : [];
  return [
    ...checkMandatorySectionsOrder(sections),
    ...checkFailaiWildcards(failaiSection),
    ...checkFailaiProse(failaiSection),
    ...checkFailaiPathConflicts(text),
    ...evaluateProductionFileTestRule(failaiPaths),
    ...evaluateUiCoverageRule(failaiPaths),
    ...checkCacheVersionPins(sections, allowedPaths(text)),
    ...checkPriklausomybes(sections, knownTaskIds),
    ...checkAgentaiChain(sections),
    ...checkPatikra(sections),
    ...checkNeitraukta(sections),
  ];
}
