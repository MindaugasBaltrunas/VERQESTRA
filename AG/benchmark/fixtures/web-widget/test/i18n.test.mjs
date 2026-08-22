import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES, translate } from "../src/i18n.mjs";

test("every supported locale resolves a known key", () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(typeof translate("status.done", locale), "string");
  }
});

test("an unsupported locale falls back to the default one", () => {
  assert.equal(translate("status.done", "fr"), translate("status.done", DEFAULT_LOCALE));
});

test("placeholders are filled from the supplied values", () => {
  assert.equal(translate("badge.updated", "en", { when: "today" }), "Updated today");
});

test("a placeholder with no value is left visible rather than blanked", () => {
  assert.equal(translate("badge.updated", "en"), "Updated {when}");
});
