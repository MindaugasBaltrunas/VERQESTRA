// Kalbų registras code-index'ui. Behaviour etalon: AG_loop code-index/language-capabilities.ts.
import type { CodeIndexLanguage } from "./types.js";

/*
 * `status` (`active | scanned | planned`) PAŠALINTAS 2026-08-23 (operatoriaus radinys).
 *
 * `scanned` ir `planned` neturėjo nė vieno įrašo po daugiakalbio praplėtimo, o `active` liko
 * vienintele galima reikšme — laukas nustojo ką nors skirti. Ką jis kadaise reiškė, dabar tiksliau
 * pasako `extracts_*` vėliavėlės: `json` yra „aktyvus", bet be importų ir simbolių, ir būtent tai
 * skaitytojui svarbu. Laukas su viena galima reikšme yra ne kontraktas, o triukšmas.
 */
export type CodeIndexLanguageCapability = {
  language: CodeIndexLanguage;
  extensions: string[];
  parser: string;
  extracts_files: boolean;
  extracts_imports: boolean;
  extracts_symbols: boolean;
  extracts_tests: boolean;
  priority: number;
};

export const codeIndexLanguageCapabilities: CodeIndexLanguageCapability[] = [
  {
    language: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    // 2026-08-23: buvo `regex-ts-indexer`, nors indeksavimas per `ts.createSourceFile` AST vyksta
    // nuo task 1105b. Vardas, aprašantis nebeegzistuojantį būdą, klaidina lygiai taip pat kaip
    // pasenusi antraštė.
    parser: "ts-ast-indexer",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: true,
    priority: 1,
  },
  {
    // JavaScript eina per TĄ PATĮ `ts.createSourceFile` AST kaip TypeScript (`allowJs`); antro JS
    // parserio nėra. Palaikomos ABI modulių sistemos: ESM `import`/`export` atpažįstamos iš mazgo
    // tipo, o CommonJS `require()` / `module.exports` — per `ts-commonjs`, nes tai kvietimas ir
    // priskyrimas, o ne deklaracijos (2026-08-23: iki tol `.cjs` grąžindavo tuščius sąrašus, nors
    // lentelė jau skelbė pilną palaikymą).
    language: "javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    parser: "ts-ast-indexer",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: true,
    priority: 1,
  },
  {
    language: "python",
    extensions: [".py"],
    parser: "lexical-python",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: true,
    priority: 2,
  },
  {
    language: "php",
    extensions: [".php"],
    parser: "lexical-php-psr4",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: true,
    priority: 3,
  },
  {
    language: "csharp",
    extensions: [".cs"],
    parser: "lexical-csharp",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: true,
    priority: 4,
  },
  {
    language: "dotnet",
    extensions: [".csproj", ".sln", ".props", ".targets"],
    parser: "msbuild-project-graph",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: false,
    priority: 4,
  },
  {
    language: "json",
    extensions: [".json"],
    parser: "json-config-scan",
    extracts_files: true,
    extracts_imports: false,
    extracts_symbols: false,
    extracts_tests: false,
    priority: 5,
  },
  {
    /*
     * Projekto manifestai, kurie NIEKO neištraukia, bet KEIČIA ištraukimą (2026-08-24, operatoriaus
     * radinys).
     *
     * `pyproject.toml`, `setup.cfg` ir `tox.ini` daro katalogą Python paketo šaknimi, tad nuo jų
     * priklauso, ar `from app.service import run` virsta keliu, ar lieka tekstu. Iki tol jie nebuvo
     * indeksuojami, o šaknys buvo randamos atskiru FS zondavimu — ir tai sulaužė invariantą, kurį
     * `scanner.computeSourceHash` deklaruoja: kas veikia indeksą, tas privalo būti jo atspaude.
     * Pasekmė: pridėjus `pyproject.toml` importų prasmė pasikeisdavo, o `source_hash` — ne, tad
     * indeksas likdavo „fresh" ir grąžindavo seną grafą iki priverstinio perstatymo.
     *
     * Sprendimas yra INDEKSUOTI juos, o ne pridėti antrą atspaudo šaltinį: viena taisyklė, viena
     * vieta. Zondavimas dėl to nebereikalingas — markeriai vėl matomi per `knownPaths`.
     */
    language: "config",
    extensions: [".toml", ".cfg", ".ini"],
    parser: "config-scan",
    extracts_files: true,
    extracts_imports: false,
    extracts_symbols: false,
    extracts_tests: false,
    priority: 5,
  },
];

export function languageForExtension(extension: string): CodeIndexLanguage {
  const normalized = extension.toLowerCase();
  return (
    codeIndexLanguageCapabilities.find((capability) => capability.extensions.includes(normalized))?.language ?? "text"
  );
}

export function indexedCodeExtensions(): Set<string> {
  return new Set(codeIndexLanguageCapabilities.flatMap((capability) => capability.extensions));
}

/**
 * Plėtiniai, kuriuos aptarnauja ECMAScript AST kelias (TypeScript + JavaScript).
 *
 * Išvedama IŠ REGISTRO, o ne surašoma antrą kartą (2026-08-24, operatoriaus radinys). `code-map`
 * turėjo savo sąrašą, ir jis jau buvo atsilikęs: `.mts` ir `.cts` registre yra nuo pat pradžių, bet
 * į code-map skenavimą nepateko. Pasekmė tyli ir būtent tokia, kokios saugomasi — tokio failo NĖRA
 * nei diagramoje, nei aprėpties VARDIKLYJE, tad `--check` gali skelbti 100 %, kai dalis medžio
 * apskritai neapžiūrėta. Vienas sąrašas dviejose vietose anksčiau ar vėliau išsiskiria; čia jis
 * išsiskyrė tyliai.
 */
/**
 * Kalbos, kurių DEKLARACIJAS indeksas moka aprašyti.
 *
 * Tai ne „kalbos, kurias indeksuojame" — `json`, `config`, `markdown` ir `text` į indeksą patenka
 * kaip failai, bet simbolių neturi, tad diagramoje jie būtų mazgai be narių ir tik trauktų aprėptį
 * žemyn nieko nepasakydami. Predikatas paimtas iš registro (`extracts_symbols`), o ne surašytas
 * atskirai: ketvirtas sąrašas tam pačiam klausimui yra tas pats drift'as, kurį ką tik uždarėme.
 */
export function symbolBearingLanguages(): Set<CodeIndexLanguage> {
  return new Set(
    codeIndexLanguageCapabilities.filter((capability) => capability.extracts_symbols).map((capability) => capability.language),
  );
}

export function ecmascriptExtensions(): string[] {
  return codeIndexLanguageCapabilities
    .filter((capability) => capability.language === "typescript" || capability.language === "javascript")
    .flatMap((capability) => capability.extensions);
}

/*
 * `sourceHashLanguages()` PAŠALINTA 2026-08-23 (operatoriaus radinys).
 *
 * Ji atrinkdavo kalbas, patenkančias į `source_hash`, ir sąmoningai išmesdavo JSON. Pasekmė:
 * `data.json` turinio pakeitimas indekso nepasendindavo, nors tas failas indekse YRA ir neša savo
 * `hash` — indeksas laikydavo nebegaliojantį atspaudą ir vis tiek vadindavosi šviežiu.
 *
 * Taisyklė dabar viena ir be išimčių: kas patenka į indeksą, tas patenka ir į jo atspaudą
 * (`scanner.computeSourceHash`). Atrankos pagal kalbą nebereikia, tad funkcija nebeegzistuoja — o ne
 * lieka su vieninteliu kvietėju „dėl visa ko".
 */
