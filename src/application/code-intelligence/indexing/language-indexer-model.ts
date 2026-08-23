// Bendras kalbų ištraukėjų rezultato tipas (MOD-1: tipai gyvena atskirai nuo logikos, kad importų
// grafas liktų aciklinis).
//
// Forma TYČIA sutampa su `TypeScriptIndexResult`: dispatcher'is neturi žinoti, kuris ištraukėjas
// atsakė. Skiriasi tik tikslumas, ir tai užrašyta `language-capabilities` lentelėje, o ne tipe.
import type { CodeIndexEdge, CodeIndexFile, CodeIndexSymbol } from "./types.js";

export type LanguageIndexResult = {
  file: CodeIndexFile;
  symbols: CodeIndexSymbol[];
  edges: CodeIndexEdge[];
};
