import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { MARKDOWN_FILES, fixtureRoot, read, settingRows } from "./docs-helpers.mjs";

/**
 * Structural conventions the documentation keeps at all times. Green on a clean
 * checkout: a docs scenario must not break these while closing a gap.
 */

test("the changelog always carries an Unreleased section", () => {
  assert.match(read("CHANGELOG.md"), /^## \[Unreleased\]$/m);
});

test("top-level and section headings are unique within a file", () => {
  for (const file of MARKDOWN_FILES) {
    const headings = [...read(file).matchAll(/^#{1,2} (.+)$/gm)].map((match) => match[1].trim());
    assert.equal(
      new Set(headings).size,
      headings.length,
      `${file} repeats a heading, which makes its anchors ambiguous`,
    );
  }
});

test("every relative documentation link resolves", () => {
  for (const file of MARKDOWN_FILES) {
    const directory = path.dirname(path.join(fixtureRoot, file));
    for (const match of read(file).matchAll(/\]\((?!https?:)([^)#]+)/g)) {
      assert.ok(
        existsSync(path.resolve(directory, match[1])),
        `${file} links to the missing file ${match[1]}`,
      );
    }
  }
});

test("every documented setting states a default", () => {
  const rows = settingRows();
  assert.ok(rows.length > 0, "the settings table was not found or could not be parsed");
  for (const row of rows) {
    assert.notEqual(row.default, "", `the "${row.name}" row leaves its default blank`);
  }
});
