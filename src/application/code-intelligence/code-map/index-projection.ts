// Code-map įvestis — PROJEKCIJA iš code index'o, ne antras skenavimas.
//
// ## Kodėl variklių nebėra du (2026-08-24, operatoriaus sprendimas)
//
// Šis modulis anksčiau pats parsindavo `.ts`/`.tsx` per `ts.createSourceFile` ir turėjo savo
// importų rezolverį. Tai buvo ANTRAS AST variklis šalia `indexing/ts-source-indexer`, ir kaina
// pasirodė ne teorinė:
//
//   • jis turėjo SAVO plėtinių sąrašą, ir tas sąrašas atsiliko — `.mts`/`.cts` neįėjo niekada, tad
//     tokie failai nepatekdavo nei į diagramą, nei į aprėpties VARDIKLĮ, o `--check` skelbdavo
//     100 % neapžiūrėjęs dalies medžio;
//   • jo `resolveImportTarget` sprendė TIK reliatyvius kelius, tad kiekvienas alias ar
//     path-mapped importas (`@lib/x`) iš diagramos dingdavo — nors indeksas jį jau turėjo
//     išsprendęs per tikrą tsconfig rezoliuciją.
//
// Dvi to paties klausimo realizacijos anksčiau ar vėliau išsiskiria, ir skirtumas pasirodo kaip
// tyliai nepilna diagrama. Todėl code-map dabar SKAITO indeksą: viena AST tiesa, viena rezoliucija.
//
// ## Ką tai palieka šiam moduliui
//
// Tik grynas atvaizdavimas: indekso įrašai → `SymbolRecord`/`ImportEdge`/`ScannedFile` su sluoksniu.
// Jokio IO, jokio parsinimo, jokios rezoliucijos.

import { toPosixPath } from "../../../shared/paths.js";
import { symbolBearingLanguages } from "../indexing/language-capabilities.js";
import type { CodeIndexData, CodeIndexSymbolKind } from "../indexing/types.js";

export type SymbolRecordKind = "class" | "function" | "method" | "const" | "enum" | "interface" | "typeAlias";

export type SymbolRecord = {
  kind: SymbolRecordKind;
  name: string;
  filePath: string;
  layer: string;
};

/**
 * Importo ryšys. `toTarget` yra tai, ką indeksas JAU IŠSPRENDĖ: repo-santykinis kelias vidiniam
 * importui arba modulio vardas išoriniam. Anksčiau čia gulėjo neapdorotas specifikatorius
 * (`toModule`), kurį code-map bandė spręsti pats — ir mokėjo už tai alias importais.
 */
export type ImportEdge = {
  fromFile: string;
  fromLayer: string;
  toTarget: string;
};

export type ScannedFile = {
  filePath: string;
  layer: string;
};

export type CodeMapProjection = {
  symbols: SymbolRecord[];
  imports: ImportEdge[];
  /**
   * KIEKVIENAS projekcijos failas su savo sluoksniu — ir tie, kurie neturi nė vieno eksportuoto
   * simbolio (2026-08-23, RAG auditas 3).
   *
   * Iki tol failų sąrašas buvo išvedamas iš simbolių, tad failas be eksportų į `source_files_total`
   * apskritai nepatekdavo: code-map neturėjo jo mazgo, importai į jį būdavo nutylimi, o aprėptis
   * vis tiek rodydavo 100 %. Aprėptis, nematanti to, ko trūksta, matuoja pati save.
   */
  files: ScannedFile[];
};

/**
 * Darbo sričių ribos — katalogai su INDEKSUOTU `package.json`.
 *
 * Išvedama iš indekso, o ne surašoma (2026-08-24, operatoriaus radinys). Iki tol projekcija turėjo
 * fiksuotą šaknų sąrašą (`[{ relativeDir: "src" }]`), paveldėtą iš etalono, kur šaknys buvo
 * hardcoded. Šiame repo tai reiškė, kad į diagramą IR į aprėpties vardiklį patekdavo 846 failai,
 * o 328 (`ui-app/src`, `mobile-gateway/src`, `mobile-app/src`, `scripts/`) nepatekdavo — tad
 * `--check` skelbdavo 100 % neapžiūrėjęs beveik trečdalio repo.
 *
 * Sąrašas būtų senęs su kiekviena nauja darbo sritimi: `mobile-app` prijungtas šią savaitę ir
 * iškart būtų buvęs nematomas. Ilgiausias prefiksas laimi, tad įdėtos darbo sritys priskiriamos
 * tiksliai; repo šaknis (`""`) yra paskutinė atsarga.
 */
function packageDirectories(data: CodeIndexData): string[] {
  const directories = new Set<string>([""]);
  for (const file of data.files) {
    if (file.path !== "package.json" && !file.path.endsWith("/package.json")) continue;
    const slash = file.path.lastIndexOf("/");
    directories.add(slash === -1 ? "" : file.path.slice(0, slash));
  }
  return [...directories].sort((left, right) => right.length - left.length);
}

/**
 * Sluoksnis: darbo sritis + pirmas segmentas po jos `src/`.
 *
 * Kvalifikuojama darbo sritimi, nes monorepo skirtingi paketai turi vienodų segmentų vardų
 * (`model`, `view`), ir nekvalifikuoti jie diagramoje susilietų į vieną sekciją — mazgai iš
 * skirtingų paketų atrodytų kaip tas pats sluoksnis.
 */
export function layerForPath(filePath: string, packages: readonly string[]): string {
  const posix = toPosixPath(filePath);
  const owner = packages.find((directory) => directory === "" || posix.startsWith(`${directory}/`)) ?? "";
  const withinPackage = owner === "" ? posix : posix.slice(owner.length + 1);
  const withoutSrc = withinPackage.startsWith("src/") ? withinPackage.slice("src/".length) : withinPackage;
  const slash = withoutSrc.indexOf("/");
  const segment = slash === -1 ? "root" : withoutSrc.slice(0, slash);
  return owner === "" ? segment : `${owner}/${segment}`;
}

/**
 * Kalbos, patenkančios į code-map: VISOS, kurių deklaracijas indeksas moka aprašyti.
 *
 * ŽINGSNIS 2 (2026-08-24, operatoriaus sprendimas). Iki tol apimtis buvo ECMAScript šeima — tiek,
 * kiek mokėjo senasis skeneris. Pasekmė mišriame repo buvo ta pati, dėl kurios visa ši serija ir
 * prasidėjo: Python, PHP ir C# failai į `source_files_total` nepatekdavo, tad `--check` skelbdavo
 * 100 % neapžiūrėjęs jų visai. Aprėptis, kurios vardiklį lemia tas pats, ką ji matuoja, negali
 * parodyti trūkumo.
 *
 * `json`/`config`/`markdown`/`text` NEĮEINA sąmoningai: jie indekse yra, bet simbolių neturi, tad
 * diagramoje būtų mazgai be narių — trauktų aprėptį žemyn nieko nepasakydami.
 *
 * KAINA, kurią tai atneša: `--check` prieš SENĄ `.mmd` mišriame repo grąžins 1, kol žemėlapis
 * nebus perkurtas su `--write`. Tai vienkartinė regeneracija, ir ji teisinga — iki tol tas pats
 * `--check` melavo.
 */
const CODE_MAP_LANGUAGES = symbolBearingLanguages();

/** Indekso simbolio rūšis → diagramos rūšis. Metodą atpažįstame iš `Klasė.narys` vardo formos. */
function symbolRecordKind(kind: CodeIndexSymbolKind, name: string): SymbolRecordKind {
  switch (kind) {
    case "class":
      return "class";
    case "interface":
      return "interface";
    case "type":
      return "typeAlias";
    case "enum":
      return "enum";
    case "const":
      return "const";
    case "function":
      // Indeksas metodo atskiros rūšies neturi — eksportuotos klasės narys ten yra `function`
      // vardu `Klasė.narys`. Diagramai tas skirtumas matomas, tad atkuriamas iš vardo.
      //
      // Taškas vardе yra ECMAScript požymis ir kitoms kalboms nesuveikia klaidingai: C# įdėtinis
      // tipas (`Outer.Inner`) indekse yra `class`, ne `function`, tad į šią šaką nepatenka; Python
      // metodai į indeksą apskritai neįtraukiami, o PHP funkcijos yra top-level.
      return name.includes(".") ? "method" : "function";
  }
}

/**
 * Code-map įvestis iš jau pastatyto indekso.
 *
 * Gryna: tie patys duomenys visada duoda tą pačią projekciją. Imamas KIEKVIENAS simbolius turintis
 * indekso failas — šaknų filtro nebėra, nes būtent jis darė aprėptį melagingą. `.d.ts` praleidžiami:
 * jie yra deklaracijos, ne implementacija.
 */
export function projectCodeMapFromIndex(data: CodeIndexData): CodeMapProjection {
  const packages = packageDirectories(data);
  const layerByFile = new Map<string, string>();
  const files: ScannedFile[] = [];

  for (const file of data.files) {
    if (!CODE_MAP_LANGUAGES.has(file.language) || file.path.endsWith(".d.ts")) continue;
    const layer = layerForPath(file.path, packages);
    layerByFile.set(file.path, layer);
    files.push({ filePath: file.path, layer });
  }

  const symbols: SymbolRecord[] = [];
  for (const symbol of data.symbols) {
    const layer = layerByFile.get(symbol.file);
    if (layer === undefined || !symbol.exported) continue;
    symbols.push({ kind: symbolRecordKind(symbol.kind, symbol.name), name: symbol.name, filePath: symbol.file, layer });
  }

  const imports: ImportEdge[] = [];
  for (const file of data.files) {
    const layer = layerByFile.get(file.path);
    if (layer === undefined) continue;
    for (const target of file.imports) {
      imports.push({ fromFile: file.path, fromLayer: layer, toTarget: target });
    }
  }

  symbols.sort((left, right) => left.filePath.localeCompare(right.filePath) || left.name.localeCompare(right.name));
  imports.sort((left, right) => left.fromFile.localeCompare(right.fromFile) || left.toTarget.localeCompare(right.toTarget));
  files.sort((left, right) => left.filePath.localeCompare(right.filePath));
  return { symbols, imports, files };
}
