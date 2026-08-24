// README produkto intencijos parseris + krautuvas (etalonas: AG_loop orchestrator/
// architecture/readme-intent.ts 1:1). Tai realus `BootstrapSpecPorts.loadReadmeProductIntent`
// tiekėjas: `ProductIntent`/`ProductIntentSection` formos atitinka application/
// project-bootstrap/generate.ts porto kontraktą struktūriškai. README skaitomas TRIMMED
// (etalono readTextIfExists semantika) — vien whitespace README yra "readme-empty".

import path from "node:path";
import { markdownFenceMask } from "../../shared/markdown.js";
import type { ExplicitStackChoice } from "../../domain/policies/stack-decision-matrix.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

export type { ExplicitStackChoice };

export type ReadmeSection = {
  heading: string;
  level: number;
  bullets: string[];
  paragraphs: string[];
};

export type ProductIntent = {
  kind: "intent";
  title?: string;
  sections: ReadmeSection[];
};

export type NoIntentResult = {
  kind: "no-intent";
  reason: "readme-missing" | "readme-empty";
};

export type ReadmeIntentResult = ProductIntent | NoIntentResult;

const ATX_HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const DASH_BULLET_PATTERN = /^[-*]\s+(.*)$/;
const NUMBERED_BULLET_PATTERN = /^\d+\.\s+(.*)$/;

function isEmptySection(section: ReadmeSection): boolean {
  return section.heading === "" && section.bullets.length === 0 && section.paragraphs.length === 0;
}

export function parseReadmeIntent(content: string): ProductIntent {
  const lines = content.split(/\r?\n/);
  const sections: ReadmeSection[] = [];

  let current: ReadmeSection = { heading: "", level: 0, bullets: [], paragraphs: [] };

  const closeCurrentSection = () => {
    if (current.level === 0) {
      if (!isEmptySection(current)) {
        sections.push(current);
      }
    } else {
      sections.push(current);
    }
  };

  // Fence-aware (2026-08-24, RAG auditas 5): README, iš kurio `bootstrap-project` generuoja
  // architektūrą ir pirmąsias užduotis, beveik visada turi ```bash blokų su `# komentarais`.
  // Aklas parseris juos laikė 1 lygio antraštėmis ir suskaidydavo produkto ketinimą į fantomines
  // sekcijas. Ta pati `markdownFenceMask` taisyklė kaip visur kitur.
  const fenced = markdownFenceMask(lines);
  for (const [index, rawLine] of lines.entries()) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine === "") {
      continue;
    }

    const headingMatch = fenced[index] === true ? null : ATX_HEADING_PATTERN.exec(trimmedLine);
    if (headingMatch) {
      closeCurrentSection();
      current = {
        heading: (headingMatch[2] ?? "").trim(),
        level: (headingMatch[1] ?? "").length,
        bullets: [],
        paragraphs: [],
      };
      continue;
    }

    const dashBulletMatch = DASH_BULLET_PATTERN.exec(trimmedLine);
    if (dashBulletMatch) {
      current.bullets.push((dashBulletMatch[1] ?? "").trim());
      continue;
    }

    const numberedBulletMatch = NUMBERED_BULLET_PATTERN.exec(trimmedLine);
    if (numberedBulletMatch) {
      current.bullets.push((numberedBulletMatch[1] ?? "").trim());
      continue;
    }

    current.paragraphs.push(trimmedLine);
  }

  closeCurrentSection();

  const title = sections.find((section) => section.level === 1)?.heading;

  return { kind: "intent", ...(title === undefined ? {} : { title }), sections };
}

export async function loadReadmeProductIntent(projectRoot: string): Promise<ReadmeIntentResult> {
  const root = path.resolve(projectRoot);
  const content = (await nodeFsAdapter.readTextFileIfExists(path.join(root, "README.md")))?.trim();

  if (content === undefined) {
    return { kind: "no-intent", reason: "readme-missing" };
  }
  if (content === "") {
    return { kind: "no-intent", reason: "readme-empty" };
  }

  return parseReadmeIntent(content);
}

const STACK_SECTION_HEADING_PATTERN = /^(tech\s+)?stack$/i;
const STACK_FIELD_BULLET_PATTERN = /^([a-zA-Z][a-zA-Z-]*)\s*:\s*(.+)$/;

/**
 * Explicit stack choice entry path: a `## Stack` (or `## Tech Stack`) README section with
 * `language:` / `framework:` / `architectureStyle:` (`architecture-style` and `style` also
 * accepted) bullets. Any bullet that does not match one of those keys is ignored. Returns
 * undefined when there is no such section, or none of its bullets carry a recognized field —
 * callers then fall back to signal-driven inference (see `deriveStackDecision`).
 */
export function extractExplicitStackChoice(intent: ProductIntent): ExplicitStackChoice | undefined {
  const section = intent.sections.find((candidate) => STACK_SECTION_HEADING_PATTERN.test(candidate.heading.trim()));
  if (!section) {
    return undefined;
  }

  const fields = new Map<string, string>();
  for (const bullet of section.bullets) {
    const match = STACK_FIELD_BULLET_PATTERN.exec(bullet.trim());
    if (!match) continue;
    fields.set((match[1] ?? "").toLowerCase(), (match[2] ?? "").trim());
  }

  const language = fields.get("language");
  const framework = fields.get("framework");
  const architectureStyle =
    fields.get("architecturestyle") ?? fields.get("architecture-style") ?? fields.get("style");

  if (language === undefined && framework === undefined && architectureStyle === undefined) {
    return undefined;
  }

  const choice: ExplicitStackChoice = {};
  if (language !== undefined) choice.language = language;
  if (framework !== undefined) choice.framework = framework;
  if (architectureStyle !== undefined) choice.architectureStyle = architectureStyle;
  return choice;
}
