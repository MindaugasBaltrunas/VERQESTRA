import assert from "node:assert/strict";
import test from "node:test";

import { read, readJson } from "./docs-helpers.mjs";

/**
 * Gap report as a test. RED on a clean checkout — see the fixture README.
 *
 * `docs/releases.json` lists every published version; 0.3.0 shipped without a
 * changelog entry.
 */

const changelogVersions = () =>
  [...read("CHANGELOG.md").matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((match) => match[1]);

test("every published release has a changelog section", () => {
  const recorded = new Set(changelogVersions());
  const missing = readJson("docs/releases.json").releases.filter(
    (release) => !recorded.has(release),
  );
  assert.deepEqual(missing, [], `releases without a changelog entry: ${missing.join(", ")}`);
});

test("changelog sections run newest first", () => {
  const versions = changelogVersions();
  const descending = [...versions].sort((left, right) =>
    right.localeCompare(left, "en", { numeric: true }),
  );
  assert.deepEqual(versions, descending);
});
