// Leksiniai pagalbininkai kalboms, kurioms neturime parserio.
//
// TypeScript ir JavaScript eina per tikrą `ts.createSourceFile` AST. Python, PHP, C# ir .NET
// projektų failams parserio nėra ir naujos priklausomybės pridėti negalima be atskiro patvirtinimo,
// tad jų deklaracijos randamos leksiškai. Kad tai nebūtų „regex ant žalio teksto", visi ištraukėjai
// pirma pravaro tekstą per `blankOutNoise`: komentarai ir eilučių literalai PAKEIČIAMI TARPAIS, o ne
// išmetami. Ilgis nesikeičia, tad poslinkiai lieka teisingi ir eilučių numeriai — tikri.
//
// Ką tai duoda praktiškai: `# import os` komentare ir `"use App\\Model"` eilutėje nebeatrodo kaip
// deklaracijos. Ko tai neduoda: makro ir generuoto kodo semantikos. Riba įvardyta sąmoningai —
// leksinis ištraukėjas turi būti nuspėjamas, o ne beveik teisingas.

/** Komentarų sintaksė. `c` — `//` ir `/* *\/`; `hash` — `#`; `xml` — `<!-- -->`. */
export type CommentStyle = "c" | "hash" | "xml";

type QuoteRule = {
  /** Eilučių literalų atidarymo simboliai. */
  quotes: readonly string[];
  /** Ar `\` ekranuoja kitą simbolį literalo viduje. */
  escapes: boolean;
};

const SPACE = " ";

/**
 * Komentarus ir eilučių literalus pakeičia tarpais, IŠSAUGODAMAS ilgį ir naujas eilutes.
 *
 * Naujos eilutės paliekamos, kad eilučių skaičiavimas veiktų; visa kita virsta tarpais.
 */
export function blankOutNoise(text: string, style: CommentStyle, quoteRule: QuoteRule): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== "\n") out[index] = SPACE;
    }
  };

  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);

    if (style === "c" && rest.startsWith("//")) {
      const end = text.indexOf("\n", index);
      blank(index, end === -1 ? text.length : end);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (style === "c" && rest.startsWith("/*")) {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (style === "hash" && rest.startsWith("#")) {
      const end = text.indexOf("\n", index);
      blank(index, end === -1 ? text.length : end);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (style === "xml" && rest.startsWith("<!--")) {
      const end = text.indexOf("-->", index + 4);
      const stop = end === -1 ? text.length : end + 3;
      blank(index, stop);
      index = stop;
      continue;
    }

    const quote = quoteRule.quotes.find((candidate) => rest.startsWith(candidate));
    if (quote !== undefined) {
      const stop = endOfLiteral(text, index, quote, quoteRule.escapes);
      blank(index + quote.length, stop - quote.length);
      index = stop;
      continue;
    }

    index += 1;
  }

  return out.join("");
}

function endOfLiteral(text: string, start: number, quote: string, escapes: boolean): number {
  let index = start + quote.length;
  while (index < text.length) {
    if (escapes && text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text.startsWith(quote, index)) return index + quote.length;
    index += 1;
  }
  return text.length;
}

/** Python: trigubos kabutės pirma, kad `"""…"""` nebūtų perskaityta kaip dvi tuščios eilutės. */
export const PYTHON_QUOTES: QuoteRule = { quotes: ['"""', "'''", '"', "'"], escapes: true };
export const C_LIKE_QUOTES: QuoteRule = { quotes: ['"', "'"], escapes: true };
export const XML_QUOTES: QuoteRule = { quotes: [], escapes: false };

/**
 * 1-based eilutės numeris pagal poslinkį.
 *
 * Kvietėjas paduoda IŠ ANKSTO paruoštą naujų eilučių indeksą, nes ištraukėjai kviečia tai kartą
 * kiekvienai deklaracijai: skaičiuoti nuo pradžios kiekvieną kartą būtų kvadratinis darbas dideliame
 * faile.
 */
export function lineIndex(text: string): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") offsets.push(index);
  }
  return offsets;
}

export function lineAt(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid] as number) < offset) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}

/** Eilutės, kurioje yra `offset`, įtrauka (tabas = vienas simbolis, kaip ir Python'e). */
export function indentAt(text: string, offset: number): number {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let indent = 0;
  while (lineStart + indent < text.length && (text[lineStart + indent] === " " || text[lineStart + indent] === "\t")) {
    indent += 1;
  }
  return indent;
}
