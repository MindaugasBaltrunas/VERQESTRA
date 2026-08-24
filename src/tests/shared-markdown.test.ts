import assert from "node:assert/strict";
import test from "node:test";
import { extractSection, firstHeading, markdownFenceMask, splitLines, stripBulletPrefix } from "../shared/markdown.js";

test("splitLines handles both LF and CRLF", () => {
  assert.deepEqual(splitLines("a\nb\r\nc"), ["a", "b", "c"]);
});

test("stripBulletPrefix removes leading -/* markers and trims", () => {
  assert.equal(stripBulletPrefix("- item "), "item");
  assert.equal(stripBulletPrefix("* item"), "item");
  assert.equal(stripBulletPrefix("plain"), "plain");
});

test("firstHeading finds the first heading at the requested level only", () => {
  const doc = "## sub\n# Title\n# Second\n### deep";
  assert.equal(firstHeading(doc), "Title");
  assert.equal(firstHeading(doc, 2), "sub");
  assert.equal(firstHeading(doc, 3), "deep");
  assert.equal(firstHeading("no headings"), undefined);
  assert.equal(firstHeading("### only-deep", 1), undefined, "(?!#) must exclude deeper headings");
});

test("extractSection returns the body up to the next heading of ANY level", () => {
  const doc = "## Tikslas\npirma\nantra\n### gilesnis\nkitas\n## Kita\nne";
  assert.equal(extractSection(doc, "## Tikslas"), "pirma\nantra");
  assert.equal(extractSection(doc, "## Kita"), "ne");
  assert.equal(extractSection(doc, "## Nėra"), "");
});

test("extractSection matches the heading line exactly (trimmed), not as a prefix", () => {
  const doc = "## Tikslas platus\nx\n## Tikslas\ny";
  assert.equal(extractSection(doc, "## Tikslas"), "y");
});

// 2026-08-24 (RAG auditas 4): `extractSection` buvo aklas fenced code blokams ABIEM kryptimis, ir
// abi puses tyliai iškraipydavo task'ą — o šis extractor'ius maitina VISĄ task'ų parsinimą
// (`## Veiksmas` → acceptance criteria IR BM25 užklausa; `## Spec source` → ką RAG apskritai ima).
test("extractSection: `#` fenced bloke NENUTRAUKIA sekcijos", () => {
  const doc = [
    "## Veiksmas",
    "- pirmas punktas",
    "",
    "```bash",
    "# build",
    "pnpm build",
    "```",
    "",
    "- antras punktas",
    "## Stop",
    "pabaiga",
  ].join("\n");

  const body = extractSection(doc, "## Veiksmas");
  assert.ok(body.includes("- antras punktas"), "po fenced bloko einantys punktai privalo išlikti");
  assert.ok(body.includes("pnpm build"), "paties bloko turinys irgi yra sekcijos dalis");
  assert.ok(!body.includes("pabaiga"), "tikroji kita antraštė vis dar riboja sekciją");
});

test("extractSection: antraštė fenced bloke NEPRADEDA sekcijos", () => {
  const doc = [
    "## Aprašymas",
    "Užduoties šablonas atrodo taip:",
    "",
    "```text",
    "## Neįtraukta",
    "- pavyzdinis punktas",
    "```",
    "",
    "## Neįtraukta",
    "- tikrasis punktas",
  ].join("\n");

  assert.equal(
    extractSection(doc, "## Neįtraukta"),
    "- tikrasis punktas",
    "cituojamas šablonas nėra sekcija — kitaip į pack'ą patektų pavyzdys vietoj tikro turinio",
  );
});

test("firstHeading: fenced bloko `#` nėra antraštė", () => {
  assert.equal(firstHeading("```\n# ne antraštė\n```\n# Tikra"), "Tikra");
});

test("markdownFenceMask seka CommonMark uždarymo taisyklę", () => {
  const lines = splitLines(
    ["prieš", "~~~yaml", "# pastaba", "~~~", "tarp", "````", "```", "# vis dar viduje", "````", "po"].join("\n"),
  );
  assert.deepEqual(
    markdownFenceMask(lines),
    [false, true, true, true, false, true, true, true, true, false],
    "uždaro TIK tas pats ženklas, tiek pat ar daugiau kartų",
  );
});
