import assert from "node:assert/strict";
import test from "node:test";
import { extractSection, firstHeading, splitLines, stripBulletPrefix } from "../shared/markdown.js";

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
