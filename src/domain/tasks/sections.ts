// Canonical enumeration of a task Markdown's sections. `shared/markdown`'s extractSection
// answers "give me the body under THIS heading"; compiling a task into a worker IR needs
// the complementary question — "what sections does this task actually have?" — so an
// unanticipated heading is preserved verbatim instead of silently disappearing. Boundaries
// use the exact same rule as extractSection (`/^#{1,6}\s/` OUTSIDE fenced code, trimmed
// body) — never re-derive that rule elsewhere. Pure: string in, structure out.
// Behaviour etalon: AG_loop domain/tasks/task-sections.ts, pinned by task-sections.json.
//
// ## FENCE-AWARE nuo 2026-08-24 (RAG auditas 5, griežtinantis nukrypimas)
//
// Antraštė aukščiau visą laiką deklaravo „tą pačią taisyklę kaip extractSection", ir 2026-08-24
// (auditas 4) ta taisyklė tapo fence-aware TIK vienoje pusėje — tad deklaracija tapo netiesa, o
// task'ų parsinimas gavo dvi nesutampančias sekcijų ribas. Šis kelias yra jautresnis už
// `extractSection`, nes iš jo gimsta worker IR, PAKEIČIANTIS neapdorotą task'ą prompte:
//   • ```bash blokas su `# build` eilute PERSKELDAVO sekciją, tad `## Veiksmas` strukturizuoti
//     acceptance criteria apsikarpydavo, o likutis atsirasdavo kaip atskiras elementas su
//     beprasme antrašte;
//   • užduoties šablonas ```text bloke duodavo ANTRĄ `## Patikra`, ir `duplicate_section`
//     atmesdavo visą kompiliaciją — kompresija tokiems task'ams tyliai niekada neapsimokėdavo.
// Fence taisyklė paimama iš `shared/markdown` — ta pati funkcija, ne trečia kopija.

import { markdownFenceMask, splitLines, stripBulletPrefix } from "../../shared/markdown.js";

/** Same boundary rule as `extractSection`: any ATX heading, levels 1-6, outside fenced code. */
const HEADING_BOUNDARY = /^#{1,6}\s/;

/** A bullet list item line. Non-bullet prose is deliberately NOT an item. */
const BULLET_ITEM = /^\s*[-*]\s+\S/;
const HEADING_PARTS = /^(#{1,6})\s+(.*)$/;

/** Unicode combining marks — what NFD decomposition splits `ą č ė š ž` into. */
const COMBINING_MARKS = /[̀-ͯ]/g;

export type TaskSection = {
  /** Verbatim heading line, e.g. "## Failai". Empty for content before the first heading. */
  heading: string;
  /** ATX level 1-6; `0` for the pre-heading preamble block. */
  level: number;
  /**
   * Match key: diacritics folded, lowercased, whitespace collapsed. "## Neįtraukta" and
   * "## Neitraukta" share a key; a DECORATED heading does not share one with its base, so
   * it stays unrecognized (and preserved) rather than guessed into a known meaning.
   */
  key: string;
  /** Verbatim body up to the next heading, trimmed exactly like `extractSection`. */
  body: string;
};

/**
 * Heading text reduced to a stable match key: deterministic Unicode decomposition
 * (NFD + combining-mark removal), not a hand-written letter table — task files are written
 * by both humans and LLMs and only one of them types diacritics reliably.
 */
export function normalizeTaskHeading(heading: string): string {
  return heading
    .replace(/^\s*#{1,6}\s*/, "")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Bullet items of a task section body, each stripped of its `- `/`* ` marker and trimmed.
 * Prose lines are intentionally not items: a caller that must not lose them detects the
 * leftover lines itself. The single implementation for every task-bullet reader.
 */
export function taskBulletItems(body: string): string[] {
  return splitLines(body ?? "")
    .filter((line) => BULLET_ITEM.test(line))
    .map((line) => stripBulletPrefix(line))
    .filter(Boolean);
}

/**
 * Every section of a task Markdown in document order, including the pre-heading preamble
 * (approval evidence lives there as a bare line under `# Task`, belonging to no `##`
 * section — a compiler walking only `##` headings would drop a human's authorization).
 * Empty-bodied sections are still returned; only a missing preamble yields no section.
 */
export function enumerateTaskSections(taskMarkdown: string): TaskSection[] {
  const lines = splitLines(taskMarkdown ?? "");
  const sections: TaskSection[] = [];
  let current: { heading: string; level: number; body: string[] } = { heading: "", level: 0, body: [] };

  const flush = (): void => {
    if (current.level === 0 && current.body.every((line) => line.trim() === "")) {
      return;
    }
    sections.push({
      heading: current.heading,
      level: current.level,
      key: current.heading ? normalizeTaskHeading(current.heading) : "",
      body: current.body.join("\n").trim(),
    });
  };

  const fenced = markdownFenceMask(lines);
  for (const [index, line] of lines.entries()) {
    if (fenced[index] !== true && HEADING_BOUNDARY.test(line)) {
      flush();
      const parts = HEADING_PARTS.exec(line);
      current = { heading: line.trim(), level: parts?.[1]?.length ?? 1, body: [] };
      continue;
    }
    current.body.push(line);
  }
  flush();

  return sections;
}
