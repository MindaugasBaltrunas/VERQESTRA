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

/**
 * `t(...)` su TIESIOGINIU literalu; kintamieji praleidžiami — jų reikšmės čia nežinomos.
 *
 * Iki 2026-09-05 šablonas matė TIK `t("…")` su dvigubomis kabutėmis ir tuoj pat einančiu `)`.
 * Vadinasi, trys visiškai įprastos formos — `t('…')`, `` t(`…`) `` ir `t("…", reikšmė)` — vartui
 * buvo nematomos, ir kiekviena jų būtų nuvedusi tiesiai į tą patį 2026-08-24 radinį: raktas
 * šaltinyje yra, vertimo nėra, `t()` tyliai grąžina patį raktą, o ekrane lieka angliškas žodis.
 * Interpoliuotas template (`` t(`x${y}`) ``) sąmoningai lieka už ribų — jo reikšmė nežinoma čia.
 */
const LITERAL_KEY = /\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`\\$]*)`)\s*[,)]/g;

/** Pirmas užpildytas literalo variantas: kabutės skiriasi, raktas — ne. */
function keyOf(match: RegExpMatchArray): string | undefined {
  return match[1] ?? match[2] ?? match[3];
}

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
      const key = keyOf(match);
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

/**
 * Nepanaudotų raktų LUBOS, kalibruotos pagal korpusą 2026-09-05 (285 iš 993).
 *
 * Užduotis prašė vardinio dinaminių raktų sąrašo. Korpusas to neleidžia: tokių raktų yra 285 —
 * beveik trečdalis žodyno (ekranų pavadinimai, principai, būsenos, verdiktai, priežastys), ir jie
 * pasiekia `t()` per kintamąjį iš duomenų. Jų literalus sąrašas būtų 285 eilutės viename testų
 * faile, t. y. tiesioginis 500 eilučių varto pažeidimas. Todėl taisyklė SIAURINAMA iki to, ką
 * korpusas tenkina: vietoj PROPORCIJOS — absoliutus, pin'intas skaičius.
 *
 * Skirtumas nėra kosmetinis. `unused < translated / 2` prie 993 raktų leidžia 496 nepanaudotus,
 * t. y. dar 211 naujų mirusių eilučių be jokio signalo, ir riba auga kartu su žodynu — kuo daugiau
 * šiukšlių, tuo daugiau jų leidžiama. Pin'inta riba nejuda: kiekvienas naujas nepanaudotas raktas
 * yra raudonas, kol kas nors arba jį suvielina, arba SĄMONINGAI pakelia šį skaičių commit'e.
 */
const MAX_UNUSED_KEYS = 285;

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

  it("nepanaudotų raktų skaičius neviršija pin'intos ribos", () => {
    const used = usedKeys();
    const translated = [...translatedKeys()];
    const unused = translated.filter((key) => !used.has(key)).sort();

    expect(
      unused.length,
      `nepanaudotų raktų padaugėjo (${unused.length} > ${MAX_UNUSED_KEYS}). Naujausi kandidatai:\n` +
        `${unused.slice(-10).join("\n")}\n` +
        "Arba raktas suvielinamas, arba MAX_UNUSED_KEYS keliamas SĄMONINGAI — bet ne tyliai.",
    ).toBeLessThanOrEqual(MAX_UNUSED_KEYS);

    // Pačios ribos riba: ji niekada negali būti pakelta virš senosios, silpnesnės proporcijos.
    // Be šito „sąmoningas pakėlimas" būtų neribotas, ir vartas grįžtų ten, iš kur atėjo.
    expect(MAX_UNUSED_KEYS).toBeLessThan(translated.length / 2);
  });

  it("apėjimai, kuriuos šis vartas privalo pagauti, yra raudoni", () => {
    // Fixture'ai, ne komponentai: šablonas tikrinamas prieš tekstą, kurio `ui-app/src` neturi.
    const keysIn = (source: string): string[] =>
      [...source.matchAll(LITERAL_KEY)].flatMap((match) => keyOf(match) ?? []);

    expect(keysIn('t("dvigubos")')).toEqual(["dvigubos"]);
    expect(keysIn("t('viengubos')")).toEqual(["viengubos"]);
    expect(keysIn("t(`backtick`)")).toEqual(["backtick"]);
    expect(keysIn('t("su-argumentu", count)')).toEqual(["su-argumentu"]);
    expect(keysIn('t( "su-tarpais" )')).toEqual(["su-tarpais"]);
    // Interpoliacija ir kintamieji lieka už ribų SĄMONINGAI — jų reikšmė čia nežinoma.
    expect(keysIn("t(`raktas-${mode}`)")).toEqual([]);
    expect(keysIn("t(control.label)")).toEqual([]);
    expect(keysIn("format(\"ne raktas\")")).toEqual([]);
  });
});
