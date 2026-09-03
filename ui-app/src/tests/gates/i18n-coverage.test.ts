import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * LIETUVIŠKO ŽODYNO DENGIAMUMAS (2026-08-24, operatoriaus radinys: „lietuviškame UI lieka
 * angliški stulpelių pavadinimai").
 *
 * Priežastis nebuvo trūkstamas `t()` — jį turi VISI `<th>`. `t()` nerastą raktą grąžina TOKĮ,
 * KOKS JIS YRA, tad praleistas vertimas atrodo lygiai kaip veikiantis kodas: nieko nelūžta,
 * niekas nespėja, o ekrane lieka angliškas žodis. Tyliai degraduojantis fallback yra teisingas
 * elgesys runtime'e ir bevertis kaip signalas, todėl signalas turi būti čia.
 *
 * Vartas skaito ŠALTINĮ, o ne kviečia `t()`: raktai išbarstyti po 60+ komponentų, ir vienintelis
 * būdas pamatyti juos visus yra tekstas. Dinaminiai raktai (`t(control.label)`, `t(variant.verdict)`)
 * čia nepatenka sąmoningai — jų reikšmės ateina iš serverio, ne iš šaltinio.
 */

const sourceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dictionaryFile = path.join(sourceRoot, "i18n", "I18nContext.tsx");

/** `t("...")` su TIESIOGINIU literalu; kintamieji praleidžiami — jų reikšmės čia nežinomos. */
const LITERAL_KEY = /\bt\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;

/**
 * Komentarai išmetami PRIEŠ skenavimą.
 *
 * Be to vartas gaudo pats save: dokumentacinis sakinys, paaiškinantis, ką jis tikrina, savaime
 * tampa „neišverstu raktu" (taip ir nutiko 2026-08-24 — komentare buvo `t` su daugtaškiu).
 * Vartas, kurį laužo komentaras, moko komentarų nerašyti.
 *
 * Eilutės literalas su `//` (pvz. URL) čia gali būti apkirptas — tai reikštų PRALEISTĄ raktą, ne
 * melagingą kritimą, o vertimo raktų su URL nėra.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [full];
  });
}

function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of sourceFiles(sourceRoot)) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(LITERAL_KEY)) {
      const key = match[1];
      if (key !== undefined && key !== "" && !keys.has(key)) {
        keys.set(key, path.relative(sourceRoot, file));
      }
    }
  }
  return keys;
}

/** Žodyno raktai: `"raktas": "vertimas"` viršutiniame `lt` objekte. */
function translatedKeys(): Set<string> {
  const source = readFileSync(dictionaryFile, "utf8");
  const start = source.indexOf("const lt: Record<string, string> = {");
  expect(start, "žodyno deklaracija nerasta — vartas lygintų tuštumą").not.toBe(-1);
  const end = source.indexOf("\n};", start);
  expect(end, "žodynas neuždarytas").not.toBe(-1);
  const block = source.slice(start, end);
  return new Set(
    [...block.matchAll(/^ {2}"((?:[^"\\]|\\.)*)":/gm)].flatMap((match) => match[1] ?? []),
  );
}

describe("lietuviško žodyno dengiamumas", () => {
  it("kiekvienas šaltinyje užrašytas raktas turi lietuvišką vertimą", () => {
    const used = usedKeys();
    const translated = translatedKeys();

    // Be šių dviejų vartas praeitų TUŠČIAS: sugedęs regex paverstų jį tyliu pritarimu — lygiai
    // tokiu pat, kokį jis ir gaudo.
    expect(used.size).toBeGreaterThan(100);
    expect(translated.size).toBeGreaterThan(100);

    const missing = [...used.entries()]
      .filter(([key]) => !translated.has(key))
      .map(([key, file]) => `${key}  (${file})`)
      .sort();

    expect(missing, `neišversti raktai — lietuviškame UI jie liks angliški:\n${missing.join("\n")}`)
      .toEqual([]);
  });

  it("žodyne nėra rakto, kurio niekas nenaudoja dinamiškai ar tiesiogiai", () => {
    // Šis tikrinamas ŠVELNIAI: dinaminiai raktai (agentų vardai, verdiktai, bucket'ai) šaltinyje
    // literalu nefigūruoja, tad nepanaudotų sąrašas nėra klaida — jis tik neturi augti be ribos.
    // Tikrinama tik tai, kad žodynas apskritai daugiausia naudojamas.
    const used = usedKeys();
    const translated = [...translatedKeys()];
    const unused = translated.filter((key) => !used.has(key));

    expect(unused.length).toBeLessThan(translated.length / 2);
  });
});
