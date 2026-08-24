// Code-index vertybiniai tipai ir versija. Behaviour etalon: AG_loop code-index/types.ts.
//
// 2.0.0 (task 1105b): AST-backed indexer — symbols gained line/endLine, edges gained
// reExports/references. The major bump is load-bearing: the store compares this against
// the on-disk manifest BEFORE the source-hash check, so a v1 regex-built index with an
// identical source_hash is forced through one rebuild instead of silently serving an
// index without line ranges.
//
// 2.1.0 (task 0022): TypeScript symbols gained a compact `signature`. The comparison in
// the store is exact inequality, not semver-range, so this additive minor bump forces the
// same single rebuild — a 2.0.0 index with a matching source_hash can never be served as
// if it carried signatures.
// 3.0.0 (2026-08-23): importai ir simboliai NEBE tik TypeScript'ui. JavaScript prijungtas prie to
// paties AST kelio (`allowJs`), o Python, PHP, C# ir .NET projektų failai gavo leksinius
// ištraukėjus. MAJOR, nes tas pats `source_hash` dabar reiškia visai kitą indekso turinį: 2.x
// indeksas tiems patiems failams turėjo tuščius `imports`/`symbols`, ir be kėlimo jis grįžtų kaip
// šviežias, o architektūros ribų patikra tyliai remtųsi nesamu grafu.
// 3.1.0 (2026-08-23): leksinės kalbos ėmė kurti GRAFO BRIAUNAS. 3.0.0 užpildė `file.imports` ir
// simbolius, bet grąžino `edges: []`, tad `code-graph` ir architektūros ribų vartas naujų kalbų
// nematė — jie skaito būtent `imports` briaunas. Kėlimas būtinas dėl tos pačios priežasties kaip
// 3.0.0: lokaliai pastatytas 3.0.0 indeksas su tuo pačiu `source_hash` turi importus, bet neturi
// briaunų, ir be kėlimo grįžtų kaip šviežias.
// 3.2.0 (2026-08-23): pataisytas testų atpažinimas (`test_main.py` — dažniausia pytest forma —
// testu NEBUVO laikoma; `.test.mjs`/`.test.cjs` irgi ne). Tai keičia `isTest`, `kind` IR `testedBy`
// briaunas tiems patiems failams, tad seni indeksai su sutampančiu `source_hash` privalo tapti
// nebegaliojantys.
// 3.3.0 (2026-08-23): CommonJS. `require()` ir `module.exports`/`exports.x` nebuvo atpažįstami —
// jie yra kvietimas ir priskyrimas, o ne deklaracijos, tad `.cjs` (ir CJS stiliaus `.js`) failai
// grąžindavo tuščius `imports`/`exports`. Keičiasi tų pačių failų importai, eksportai IR simboliai.
// 3.4.0 (2026-08-23): `source_hash` apima KIEKVIENĄ indeksuotą failą (anksčiau JSON buvo išmestas,
// o grįždavo tik per vardų heuristiką), o `vq/supervisor` ir `vq/generated` išimti iš skenavimo —
// ten guli paties įrankio išvestis. Keičiasi ir atspaudas, ir failų sąrašas.
// 3.5.0 (2026-08-23): simbolių ID tapo unikalūs. TypeScript overload'ai suliejami į vieną simbolį,
// C# įdėtiniai tipai kvalifikuojami savininku (`Outer.Inner`). Keičiasi simbolių sąrašas, jų ID ir
// `declares`/`exports` briaunos.
// 3.6.0 (2026-08-23): pilnesnė vietinių paketų rezoliucija. Python absoliutus importas
// išsprendžiamas į repo kelią, kai kandidatas VIENAS; PSR-4 masyvo reikšmė tikrinama kaip paieškos
// seka, o ne tik pirmas katalogas. Keičiasi `imports` ir `imports` briaunos.
// 4.0.0 (2026-08-23 RAG auditas 3): MAJOR, nes pasikeitė ir manifesto FORMA, ir tai, ką indeksas
// laiko turiniu. Viename kėlime:
//   • manifestas gavo PRIVALOMĄ `records_hash` — 3.x manifestas jo neturi, tad schema jo nepriima;
//   • skenavimas nustojo aklai mesti `bin`/`obj`/`dist`/`vendor` bet kuriame gylyje (`src/bin/cli.ts`
//     buvo teisėtas produkto kodas, kurio indekse tiesiog nebuvo) — keičiasi ir failų sąrašas, ir
//     `source_hash`;
//   • eksportai nustojo generuoti simbolių neturinčius vardus (`export { a as b }` eksportuodavo ir
//     `a`; `export default a`, `module.exports = function () {}` ir `module.exports = { run() {} }`
//     duodavo kabančias briaunas; `exports = {…}` iš viso nėra eksportas) — keičiasi `exports`,
//     `symbols` ir jų briaunos;
//   • `require`/`module`/`exports` nustojo būti importu ten, kur juos užgožia vietinis vardas;
//   • Python absoliutus importas sprendžiamas tik nuo PAKETO ŠAKNIES (`import json` nebesusiejamas
//     su `src/infrastructure/json.py`), o deklaracijos pjūvis apima dekoratorius ir baigiasi ties
//     bloko įtrauka;
//   • PHP grupiniai ir kelių vardų `use` sakiniai nustojo būti nukerpami.
// 4.1.0 (2026-08-24, operatoriaus radinys): Python paketo šaknų atpažinimas. `src` išdėstymas
// atpažįstamas BET KURIAME gylyje (monorepo `packages/api/src` šaknimi netapdavo niekada), o
// `pyproject.toml`/`setup.cfg`/`tox.ini` randami per FS portą — jie nėra indeksuojami plėtiniai, tad
// iš keturių deklaruotų markerių realiai veikė tik `setup.py`. Keičiasi `imports` ir jų briaunos
// tiems patiems failams, tad tas pats `source_hash` dabar reiškia kitą grafą — MINOR pakanka, nes
// manifesto forma nesikeičia, o deskriptorius neša versiją ir anuliuoja pack'us pats.
// 4.2.0 (2026-08-24, operatoriaus radinys): projekto manifestai (`.toml`, `.cfg`, `.ini`) tapo
// INDEKSUOJAMI (`config` kalba). Jie nieko neištraukia, bet KEIČIA ištraukimą — nuo jų priklauso,
// ar Python absoliutus importas virsta keliu. Zonduojant juos per FS portą rezoliucija keisdavosi,
// o `source_hash` ne, tad indeksas likdavo klaidingai šviežias. Keičiasi failų sąrašas IR atspaudas.
export const codeIndexVersion = "4.2.0";

export type CodeIndexLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "php"
  | "csharp"
  | "dotnet"
  | "json"
  | "config"
  | "markdown"
  | "text";

export type CodeIndexFileKind = "source" | "test" | "config" | "doc";

export type CodeIndexEdgeType =
  | "imports"
  | "exports"
  | "declares"
  | "testedBy"
  // `allowedByTask` ir `relatedToSpec` PAŠALINTI 2026-08-23 (operatoriaus radinys): jie neturėjo
  // NEI gamintojo, NEI vartotojo. Code-index statomas TIK iš šaltinio failų, tad task'ų ir spec'ų
  // ryšiai jame atsirasti negalėjo — juos žino konteksto pack'o sluoksnis, ne indeksuotojas.
  // Tipas, kurio niekas negamina, skaitytojui atrodo kaip duomenys, kurių tiesiog dar nematė.
  | "reExports"
  | "references";

export type CodeIndexFile = {
  path: string;
  hash: string;
  size: number;
  language: CodeIndexLanguage;
  kind: CodeIndexFileKind;
  imports: string[];
  exports: string[];
  symbols: string[];
  isTest: boolean;
};

export type CodeIndexSymbolKind = "function" | "class" | "type" | "interface" | "const" | "enum";

export type CodeIndexSymbol = {
  id: string;
  file: string;
  name: string;
  kind: CodeIndexSymbolKind;
  exported: boolean;
  /** 1-based first line of the declaration, inclusive. Present for AST-indexed TypeScript symbols. */
  line?: number;
  /** 1-based last line of the declaration, inclusive. Always >= line when present. */
  endLine?: number;
  /**
   * Compact, whitespace-normalized declaration head — the signature a reader needs to use
   * the symbol without opening the file (`export function foo(a: string): void`). Derived
   * syntactically from the same AST that produced the line range (no TypeChecker), and
   * length-capped, so it is a REPRESENTATION of the declaration, not its source. The exact
   * source stays on disk and is read on demand from `line`/`endLine`; the index never
   * stores file contents. Present for AST-indexed TypeScript symbols.
   */
  signature?: string;
};

export type CodeIndexEdge = {
  from: string;
  to: string;
  type: CodeIndexEdgeType;
  detail?: string;
};

export type CodeIndexManifest = {
  version: string;
  generated_at: string;
  project_root: string;
  file_count: number;
  symbol_count: number;
  edge_count: number;
  source_hash: string;
  /**
   * Įrašų TURINIO atspaudas (`files`+`symbols`+`edges` JSONL baitai).
   *
   * `source_hash` atsako „ar indeksas atitinka failus"; `records_hash` — „ar saugyklos turinys yra
   * tas, kurį šis manifestas aprašo". Be jo įrašo redagavimas, išlaikantis kiekius ir schemą, lieka
   * nepastebimas (2026-08-23 RAG auditas).
   */
  records_hash: string;
};

export type CodeIndexData = {
  manifest: CodeIndexManifest;
  files: CodeIndexFile[];
  symbols: CodeIndexSymbol[];
  edges: CodeIndexEdge[];
};

export type CodeIndexFreshness =
  | { ok: true; manifest: CodeIndexManifest }
  | { ok: false; reason: string; manifest?: CodeIndexManifest };
