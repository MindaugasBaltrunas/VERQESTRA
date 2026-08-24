// Generic markdown helpers: heading/section extraction parameterized by heading text and
// level. No domain knowledge — callers own their heading names. Behaviour etalon:
// AG_loop shared/markdown (the CANONICAL section extractor — do not add another one).

const BULLET_PREFIX = /^[-*]\s+/;

export function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

// CommonMark fenced code block: ``` arba ~~~ ties 0–3 įtrauka atidaro; uždaro TAS PATS ženklas,
// tiek pat ar daugiau kartų, be info string'o.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * Kurios eilutės guli FENCED code bloke (įskaitant pačias fence eilutes).
 *
 * Kodėl tai gyvena `shared`, o ne prie kurio nors skaitytojo (2026-08-24, RAG auditas 4):
 * fence taisyklė reikalinga DVIEM nepriklausomiems markdown skaitytojams — `extractSection`
 * (visas task'ų parsinimas) ir `chunkMarkdownByHeading` (spec fragmentų antraštės). Antra
 * kopija reikštų, kad viena jų anksčiau ar vėliau atsiliks, o skirtumas pasirodytų kaip
 * „sekcija netikėtai nukirsta" — gedimas, kurio niekas nesieja su fence'ais.
 *
 * Ką tai uždaro: bash `# komentaras`, YAML `# pastaba` ar užduoties šablonas ```text bloke
 * nustoja atrodyti kaip ATX antraštė. Iki tol jis (a) NUTRAUKDAVO einamą sekciją ties savimi ir
 * (b) pats galėdavo būti rastas kaip sekcijos PRADŽIA — abu tyliai.
 */
export function markdownFenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = [];
  let open: { marker: string; length: number } | undefined;
  for (const line of lines) {
    if (open !== undefined) {
      mask.push(true);
      const marks = line.match(FENCE_CLOSE)?.[1];
      if (marks !== undefined && (marks[0] ?? "") === open.marker && marks.length >= open.length) {
        open = undefined;
      }
      continue;
    }
    const fence = line.match(FENCE_OPEN)?.[1];
    if (fence !== undefined) {
      open = { marker: fence[0] ?? "`", length: fence.length };
      mask.push(true);
      continue;
    }
    mask.push(false);
  }
  return mask;
}

/** Leading bullet marker (`- `/`* `) stripped from a single line, trimmed. */
export function stripBulletPrefix(line: string): string {
  return line.trim().replace(BULLET_PREFIX, "").trim();
}

/** Text of the first ATX heading at the given level (default 1), or undefined if none. */
export function firstHeading(content: string, level: number = 1): string | undefined {
  const marker = "#".repeat(level);
  const pattern = new RegExp(`^${marker}(?!#)\\s+(.+)$`);
  const lines = splitLines(content);
  const fenced = markdownFenceMask(lines);
  for (const [index, rawLine] of lines.entries()) {
    if (fenced[index] === true) continue;
    const match = pattern.exec(rawLine.trim());
    const captured = match?.[1];
    if (captured !== undefined) return captured.trim();
  }
  return undefined;
}

/**
 * Body text under a heading matching `heading` exactly (e.g. `"## Patikra"`), up to the
 * next ATX heading of any level (1-6) or end of document. Empty string when not found.
 *
 * FENCE-AWARE nuo 2026-08-24 (RAG auditas 4). Iki tol funkcija buvo akla fenced code blokams
 * abiem kryptimis, ir abi puses tyliai iškraipydavo task'ą:
 *
 *   • PABAIGA: ```bash blokas su `# build` eilute nutraukdavo sekciją ties tuo komentaru. Task'as,
 *     kurio `## Veiksmas` turi komandų pavyzdį, prarasdavo VISUS po jo einančius punktus — o tai
 *     yra ir worker'io „done" apibrėžimas, ir BM25 užklausos pusė.
 *   • PRADŽIA: `findIndex` imdavo PIRMĄ eilutę, lygią antraštei, tad užduoties šabloną cituojantis
 *     ```text blokas su `## Neįtraukta` tapdavo tos sekcijos pradžia, ir į pack'ą patekdavo
 *     pavyzdžio turinys vietoj tikrojo.
 *
 * Ta pati taisyklė kaip `chunkMarkdownByHeading` — ir tas pats `markdownFenceMask`, ne antra kopija.
 */
export function extractSection(content: string, heading: string): string {
  const lines = splitLines(content);
  const bounds = findSectionBounds(lines, (line) => line.trim() === heading);
  return bounds === undefined ? "" : lines.slice(bounds.start + 1, bounds.end).join("\n").trim();
}

/** Antraštės eilutės indeksas ir pirmoji eilutė PO sekcijos (`end` — eksklusyvus). */
export type MarkdownSectionBounds = { start: number; end: number };

/**
 * Sekcijos ribos eilučių indeksais — VIENA vieta, kur gyvena „kur sekcija baigiasi" taisyklė.
 *
 * 2026-08-24 (RAG auditas 5): tas pats `findIndex(heading)` + `/^#{1,6}\s/` ciklas buvo užrašytas
 * PENKIUOSE failuose (`extractSection`, `preflight-rules.backtickBareBullets`,
 * `claude-preflight.appendSpecSourceRef`, `repair-prompt.replaceOrAppendSection`,
 * `route-model.stripAgentaiSection`), nors `domain/tasks/sections` antraštė nuo pat pradžių sakė
 * „never re-derive that rule elsewhere". Kai auditas 4 padarė `extractSection` fence-aware, kitos
 * keturios kopijos liko aklos — ir kiekviena tyliai savo būdu:
 *   • `backtickBareBullets` nustodavo backtick'uoti bullet'us po fenced bloko, tad `## Patikra`
 *     komandos preflight'ui tapdavo nematomos;
 *   • `appendSpecSourceRef` įterpdavo naują spec ref'ą Į FENCED bloko vidų, kur retrieval jo
 *     niekada nepamato — tyliai ignoruotas spec šaltinis;
 *   • `replaceOrAppendSection` perrašydavo sekciją ne ties ta riba, kurią mato `extractSection`;
 *   • `stripAgentaiSection` išmesdavo per mažai, tad agentų vardai vėl patekdavo į rizikos
 *     klasifikaciją, nuo kurios TOK-02 juos ir atskyrė.
 *
 * Antraštės atitikimas paduodamas predikatu, nes kvietėjai skiriasi (tiksli eilutė vs. šablonas),
 * bet RIBA yra viena ir ji čia.
 */
export function findSectionBounds(
  lines: readonly string[],
  matchesHeading: (line: string) => boolean,
): MarkdownSectionBounds | undefined {
  const fenced = markdownFenceMask(lines);
  const start = lines.findIndex((line, index) => fenced[index] !== true && matchesHeading(line));
  if (start === -1) {
    return undefined;
  }
  for (let index = start + 1; index < lines.length; index += 1) {
    if (fenced[index] !== true && /^#{1,6}\s/.test(lines[index] ?? "")) {
      return { start, end: index };
    }
  }
  return { start, end: lines.length };
}

/**
 * Extract the relative link targets from markdown `[text](target)` links (etalono
 * domain/docs/markdown-links.ts — VERQESTRA namas čia, prie kitų grynų markdown taisyklių).
 * Naudoja release/audit README link-integrity vartai.
 *
 * Only targets that point at repository-local paths are returned. The following are skipped
 * because they are not file references we can resolve on disk: external schemes (`http:`,
 * `mailto:`, …) and protocol-relative `//` links, pure in-page anchors (`#section`), empty
 * targets. Titles (`(path "title")`) and `#anchor` fragments are stripped, angle-bracket
 * `<path>` wrappers are removed, and results are de-duplicated in first-seen order.
 */
export function extractRelativeMarkdownLinks(markdown: string): string[] {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const match of markdown.matchAll(linkPattern)) {
    const target = normalizeLinkTarget(match[1] ?? "");
    if (target === undefined || seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }

  return targets;
}

function normalizeLinkTarget(raw: string): string | undefined {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }
  // Drop an optional `"title"`/`'title'` that follows whitespace after the URL.
  const whitespaceIndex = target.search(/\s/);
  if (whitespaceIndex !== -1) target = target.slice(0, whitespaceIndex);
  // Drop an in-target `#anchor` fragment.
  const anchorIndex = target.indexOf("#");
  if (anchorIndex !== -1) target = target.slice(0, anchorIndex);
  target = target.trim();

  if (target.length === 0) return undefined;
  if (target.startsWith("//")) return undefined; // protocol-relative external
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined; // http:, https:, mailto:, …
  return target;
}
