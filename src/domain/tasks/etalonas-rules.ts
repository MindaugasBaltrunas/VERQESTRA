// Pure structural validator mirroring `AG/tasks/examples/000-etalonas.md`. This is the shared
// core: the pre-write hook and the 070 preflight gate both import `validateTaskAgainstEtalonas`
// instead of keeping their own copy of "what does a conforming task file look like". Structure
// only — whether the prose under a section actually ANSWERS it is the preflight LLM's job, not
// this one. `domain` layer: no filesystem, no clock, so the set of task ids a `## Priklausomybės`
// reference may point at arrives as a plain argument, never read from disk here.

import { enumerateTaskSections, normalizeTaskHeading, taskBulletItems, type TaskSection } from "./sections.js";
import { isPlaceholderDependency } from "./dependencies.js";

const ETALONAS_PATH = "AG/tasks/examples/000-etalonas.md";

export type Violation = {
  /** Stable machine key for the broken rule, e.g. "mandatory-section-missing". */
  ruleId: string;
  /** Heading (or label) of the section the violation belongs to. */
  section: string;
  /** Human-readable explanation, always pointing back at the etalon file. */
  message: string;
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

function violation(ruleId: string, section: string, message: string): Violation {
  return { ruleId, section, message: `${message} (žr. ${ETALONAS_PATH}).` };
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

/** Bullet lines under the `Leidžiama:` sub-list of `## Failai`, verbatim (not stripped of markers). */
function leidziamaBulletLines(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const result: string[] = [];
  let active = false;
  for (const line of lines) {
    const key = normalizeTaskHeading(line.trim());
    if (key === "leidziama:") {
      active = true;
      continue;
    }
    if (key === "draudziama:") {
      active = false;
      continue;
    }
    if (active && BULLET_LINE.test(line)) result.push(line.trim());
  }
  return result;
}

/**
 * A directory wildcard (`src/tests/**`, `components/`) under `## Failai / Leidžiama` without a
 * justification on the same bullet line. `Draudžiama` is exempt — `dist/**`/`node_modules/**`
 * are boilerplate there in every task and carry no planning cost.
 */
function checkFailaiWildcards(sections: readonly TaskSection[]): Violation[] {
  const failaiSection = findSection(sections, (key) => key === "failai");
  if (!failaiSection) return [];

  const violations: Violation[] = [];
  for (const line of leidziamaBulletLines(failaiSection.body)) {
    const match = BACKTICK_PATH.exec(line);
    if (!match) continue;
    const path = match[1] ?? "";
    const isWildcard = path.includes("**") || path.endsWith("/");
    if (!isWildcard) continue;
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
 * `## Priklausomybės` bullets: a placeholder (`none`/`-`/`TBD`, {@link isPlaceholderDependency})
 * is forbidden outright, and anything shaped like a task id must resolve inside `knownTaskIds`.
 * Free-form text that is neither (e.g. the etalon's own `<pilnas-task-id-be-md>` template) is
 * left alone — it is not a reference this rule can judge.
 */
function checkPriklausomybes(sections: readonly TaskSection[], knownTaskIds: readonly string[]): Violation[] {
  const section = findSection(sections, (key) => key === "priklausomybes");
  if (!section) return [];

  const known = new Set(knownTaskIds);
  const violations: Violation[] = [];
  for (const item of taskBulletItems(section.body)) {
    const trimmed = item.trim();
    if (isPlaceholderDependency(trimmed)) {
      violations.push(
        violation(
          "priklausomybe-placeholder",
          "## Priklausomybės",
          `Placeholder "${trimmed}" draudžiamas — arba tikras task id, arba sekcijos nėra`,
        ),
      );
      continue;
    }
    if (TASK_ID_SHAPE.test(trimmed) && !known.has(trimmed)) {
      violations.push(
        violation(
          "priklausomybe-unknown-id",
          "## Priklausomybės",
          `Priklausomybė "${trimmed}" nerasta tarp žinomų task id (queue/done)`,
        ),
      );
    }
  }
  return violations;
}

/** `## Patikra` bullets restricted to the sandbox-safe command forms. */
function checkPatikra(sections: readonly TaskSection[]): Violation[] {
  const section = findSection(sections, (key) => key === "patikra");
  if (!section) return [];

  const allowedList = ALLOWED_PATIKRA_COMMANDS.join(", ");
  const violations: Violation[] = [];
  for (const item of taskBulletItems(section.body)) {
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
 */
export function validateTaskAgainstEtalonas(text: string, knownTaskIds: readonly string[]): Violation[] {
  const sections = enumerateTaskSections(text);
  return [
    ...checkMandatorySectionsOrder(sections),
    ...checkFailaiWildcards(sections),
    ...checkPriklausomybes(sections, knownTaskIds),
    ...checkPatikra(sections),
  ];
}
