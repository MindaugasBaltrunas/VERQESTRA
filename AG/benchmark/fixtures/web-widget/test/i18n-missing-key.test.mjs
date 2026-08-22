import assert from "node:assert/strict";
import test from "node:test";

import { translate } from "../src/i18n.mjs";

/**
 * Bug report as a test. RED on a clean checkout — see the fixture README.
 *
 * `badge.updated` exists in `en` but not yet in `lt`, and `status.archived`
 * exists nowhere. A key missing from a translated catalogue must fall back to
 * the default locale, and a key missing everywhere must surface as the key
 * itself. Today both paths render the literal text "undefined".
 */

test("a key missing from a locale falls back to the default catalogue", () => {
  assert.equal(translate("badge.updated", "lt", { when: "šiandien" }), "Updated šiandien");
});

test('a key missing everywhere surfaces as the key, never as "undefined"', () => {
  const rendered = translate("status.archived", "en");
  assert.equal(rendered, "status.archived");
  assert.ok(!rendered.includes("undefined"), rendered);
});
