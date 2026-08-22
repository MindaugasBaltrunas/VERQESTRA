import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Message lookup.
 *
 * Catalogues are read from disk rather than imported so the fixture runs on any
 * Node 22 without depending on import-attribute support. Paths resolve from this
 * module, not from `process.cwd()`: the widget must render the same way whatever
 * directory a runner started in.
 *
 * KNOWN DEFECT (reproduced by `test/i18n-missing-key.test.mjs`): a key missing
 * from the requested catalogue returns `undefined`, which renders the string
 * "undefined" into the page instead of falling back to the default locale.
 */

const messagesDirectory = path.resolve(fileURLToPath(import.meta.url), "../messages");

export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "lt"];

const catalogues = new Map();

/** @param {string} locale */
function catalogue(locale) {
  const cached = catalogues.get(locale);
  if (cached !== undefined) return cached;
  const loaded = JSON.parse(readFileSync(path.join(messagesDirectory, `${locale}.json`), "utf8"));
  catalogues.set(locale, loaded);
  return loaded;
}

/**
 * @param {string} key
 * @param {string} [locale]
 * @param {Record<string, string>} [values]
 * @returns {string}
 */
export function translate(key, locale = DEFAULT_LOCALE, values = {}) {
  const resolved = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const template = catalogue(resolved)[key];
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? values[name] : match,
  );
}
