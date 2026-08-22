import assert from "node:assert/strict";
import test from "node:test";

import { readJson, settingRows } from "./docs-helpers.mjs";

/**
 * Gap report as a test. RED on a clean checkout — see the fixture README.
 *
 * `docs/settings-inventory.json` is generated from the source, so it is the
 * authority on which settings exist. `retryBackoffMs` and `logLevel` are real
 * and undocumented.
 */

test("every setting the tool reads has a row in the configuration table", () => {
  const documented = new Set(settingRows().map((row) => row.name));
  const missing = readJson("docs/settings-inventory.json").settings.filter(
    (setting) => !documented.has(setting),
  );
  assert.deepEqual(missing, [], `undocumented settings: ${missing.join(", ")}`);
});

test("the configuration table documents nothing the tool does not read", () => {
  const known = new Set(readJson("docs/settings-inventory.json").settings);
  const invented = settingRows()
    .map((row) => row.name)
    .filter((name) => !known.has(name));
  assert.deepEqual(invented, [], `documented but nonexistent settings: ${invented.join(", ")}`);
});
