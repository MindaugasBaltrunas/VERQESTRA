import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * STILIŲ DENGIAMUMAS (2026-08-26, UI auditas P2-1: „klaidos juosta atrodo kaip neutralus
 * pranešimas").
 *
 * `view/styles/` yra VIENINTELIS ui-app stilių šaltinis (`main.tsx` importuoja `dashboard.css`,
 * o šis `@import`'ais surenka likusius; CSS modulių ar inline `<style>` projekte nėra). Nuo
 * 2026-09-03 failų ten daugiau nei vienas, tad vartas skaito KATALOGĄ. Iš to plaukia, kad TSX'e
 * užrašyta, bet `dashboard.css` neapibrėžta klasė nedaro NIEKO — ir nedaro tyliai: markup'as
 * lieka teisingas, `role="alert"` lieka vietoje, testai žali, o vartotojas mato neutralų
 * stačiakampį ten, kur turėtų matyti klaidą. Būtent taip `notice-error` išgyveno trijuose
 * puslapiuose.
 *
 * Todėl vartas čia. Jis skaito ŠALTINĮ, o ne DOM'ą: klasė be taisyklės DOM'e egzistuoja
 * (`element.className` ją grąžina), tik neturi jokios išvaizdos — vienintelė vieta, kur skirtumas
 * matomas, yra tekstas.
 *
 * Vieta (`tests/gates/`) pasirinkta pagal APIMTĮ, ne temą: vartas skaito visą `src`, tad jis
 * negyvena nė viename kataloge, kurį tikrina. Iki 2026-09-03 jis stovėjo `view/components/`,
 * kur atrodė kaip vieno katalogo testas.
 *
 * Ribos, sąmoningos:
 * - Dinaminės template dalys (`mode-${mode}`) netikrinamos: jų reikšmė ateina iš duomenų.
 *   Tikrinamas tik pilnas, tarpais atskirtas literalas.
 * - Palyginimo literalai (`level === "high" ? ... : ...`) į sąrašą NEpatenka — dėl to čia
 *   naudojamas TS parseris, o ne regex: `"high"` nėra klasė, o regex to nemato.
 * - `*.test.tsx` praleidžiami: testų harness'o markup'as nėra produkto išvaizda.
 */

const sourceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const styleDir = path.join(sourceRoot, "view", "styles");

/**
 * VISI `view/styles/*.css`, o ne vienas įkaltas vardas. Iki 2026-09-03 čia stovėjo
 * `dashboard.css` — tada jis ir buvo vienintelis. Po jo suskaidymo įkaltas vardas reikštų, kad
 * į atskirą failą iškelta taisyklė vartui DINGSTA: klasė būtų apšaukta nepadengta, nors
 * stilius veikia. Riba plati sąmoningai — naujas `.css` failas patenka į vartą pats, be jokio
 * sąrašo redagavimo, tad varto apimtis negali tyliai atsilikti nuo katalogo.
 */
function styleSheets(): string[] {
  return readdirSync(styleDir)
    .filter((entry) => entry.endsWith(".css"))
    .sort()
    .map((entry) => path.join(styleDir, entry));
}

/**
 * Žymė vietoje `${…}`: ją turintis token'as yra nepilnas, todėl netikrinamas. Turi būti simbolis,
 * kurio nėra klasių varduose IR kuris token'ų NEatskiria — tarpas čia netiktų, nes `mode-${x}`
 * virstų pilnu `mode-`.
 */
const DYNAMIC = String.fromCharCode(0);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx$/.test(entry) || /\.test\.tsx$/.test(entry)) return [];
    return [full];
  });
}

/**
 * Selektorių tekstas: deklaracijų blokų turinys išmetamas, kad `content: "."` ar `url(./x)`
 * netaptų „apibrėžta klase". `@media`/`@supports` prelude'ai lieka, o jų vidus skenuojamas
 * toliau — ten irgi gyvena tikri selektoriai.
 *
 * TUŠČIAS blokas selektoriaus NEGRĄŽINA. Iki 2026-09-05 grąžindavo, ir tai buvo tiksliai tas
 * apėjimas, kurį vartas turi gaudyti: `.notice-error {}` padarydavo klasę „padengtą", nors
 * išvaizdos ji neduoda nė kiek — o būtent „markup'as teisingas, stiliaus nėra" ir yra gedimas,
 * dėl kurio šis vartas atsirado.
 */
function selectorText(css: string): string {
  let out = "";
  let selector = "";
  let index = 0;
  while (index < css.length) {
    const char = css[index];
    if (char === "{") {
      const prelude = selector;
      const nested = prelude.trimStart().startsWith("@");
      selector = "";
      index += 1;
      if (nested) {
        out += `${prelude} `;
        continue;
      }
      let depth = 1;
      const bodyStart = index;
      while (index < css.length && depth > 0) {
        if (css[index] === "{") depth += 1;
        else if (css[index] === "}") depth -= 1;
        index += 1;
      }
      const body = css.slice(bodyStart, depth === 0 ? index - 1 : index);
      if (body.trim() !== "") out += `${prelude} `;
      continue;
    }
    if (char === "}") {
      selector = "";
      index += 1;
      continue;
    }
    selector += char;
    index += 1;
  }
  return `${out} ${selector}`;
}

/**
 * `:not(.x)` klasės NEAPIBRĖŽIA — jis aprašo elementus, kurie jos NETURI. Palikta neigimo
 * konstrukcija tyliai „padengdavo" bet kokį joje paminėtą vardą, tad taisyklė
 * `.card:not(.card-flat)` legalizuodavo `card-flat` be jokio jo stiliaus.
 */
function definedClasses(css: string): Set<string> {
  // `@import` išmetamas PRIEŠ selektorių skaitymą: `"./01-tokens-base.css"` klasių regex'ui
  // atrodo kaip `.css`, ir indeksas tyliai „apibrėžtų" klasę, kurios niekas neaprašė.
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/@import[^;]*;/g, " ");
  const selectors = selectorText(cleaned).replace(/:not\([^)]*\)/g, " ");
  return new Set(
    [...selectors.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].flatMap((match) => match[1] ?? []),
  );
}

function definedClassesFromDisk(): Set<string> {
  return definedClasses(styleSheets().map((file) => readFileSync(file, "utf8")).join("\n"));
}

function classTokens(literal: string): string[] {
  return literal.split(/\s+/).filter((token) => token !== "" && !token.includes(DYNAMIC));
}

/**
 * Klasių literalai iš `className={…}` išraiškos. Sąmoningai apeinamos tik tos šakos, kurios
 * TAMPA klasių eilute: ternary abi pusės, `+`/`||`/`??` operandai, `&&` dešinė. Sąlyga
 * (`x === "high"`) praleidžiama — ten esantis literalas yra reikšmė, ne klasė.
 */
function collectLiterals(node: ts.Expression, sink: (literal: string) => void): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    sink(node.text);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    sink(node.head.text + node.templateSpans.map((span) => DYNAMIC + span.literal.text).join(""));
    return;
  }
  if (ts.isParenthesizedExpression(node)) {
    collectLiterals(node.expression, sink);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectLiterals(node.whenTrue, sink);
    collectLiterals(node.whenFalse, sink);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      collectLiterals(node.right, sink);
      return;
    }
    if (
      operator === ts.SyntaxKind.PlusToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      collectLiterals(node.left, sink);
      collectLiterals(node.right, sink);
    }
  }
}

function usedClasses(): Map<string, string> {
  const used = new Map<string, string>();
  for (const file of sourceFiles(sourceRoot)) {
    const relative = path.relative(sourceRoot, file).split(path.sep).join("/");
    const parsed = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const remember = (literal: string): void => {
      for (const token of classTokens(literal)) {
        if (!used.has(token)) used.set(token, relative);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "className") {
        const initializer = node.initializer;
        if (initializer !== undefined) {
          if (ts.isStringLiteral(initializer)) remember(initializer.text);
          else if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) {
            collectLiterals(initializer.expression, remember);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return used;
}

describe("dashboard.css dengiamumas", () => {
  it("kiekviena TSX'e užrašyta klasė turi taisyklę dashboard.css", () => {
    const used = usedClasses();
    const defined = definedClassesFromDisk();

    // Be šių dviejų vartas praeitų TUŠČIAS: sugedęs parseris paverstų jį tyliu pritarimu —
    // lygiai tokiu pat, kokį jis ir gaudo.
    expect(used.size).toBeGreaterThan(150);
    expect(defined.size).toBeGreaterThan(150);

    const missing = [...used.entries()]
      .filter(([name]) => !defined.has(name))
      .map(([name, file]) => `${name}  (${file})`)
      .sort();

    expect(
      missing,
      `klasės be taisyklės — markup'as jas turi, išvaizdos jos neduoda:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("apėjimai, kuriuos šis vartas privalo pagauti, yra raudoni", () => {
    // Fixture'ai, ne `view/styles/`: taisyklė tikrinama prieš CSS, kurio repo neturi ir neturės.
    expect([...definedClasses(".notice-error {}")]).toEqual([]);
    expect([...definedClasses(".notice-error { /* dar neparašyta */ }")]).toEqual([]);
    expect([...definedClasses(".card:not(.card-flat) { color: red; }")]).toEqual(["card"]);

    // Tai, kas ir toliau privalo skaitytis kaip apibrėžimas.
    expect([...definedClasses(".notice-error { color: red; }")]).toEqual(["notice-error"]);
    expect([...definedClasses("@media (max-width: 760px) { .panel { gap: 0; } }")]).toEqual(["panel"]);
    expect([...definedClasses(".btn:hover:not(:disabled) { opacity: 1; }")]).toEqual(["btn"]);
  });
});
