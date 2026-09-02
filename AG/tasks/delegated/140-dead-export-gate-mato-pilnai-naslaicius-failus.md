## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Sukurti gryną (be FS) failų lygio našlaičių aptikimo funkciją su savipatikra. Kontekstas: `dead-export-gate.test.ts` vartas yra TOKEN'INIS — simbolis laikomas gyvu, jei jo VARDĄ mini bet kuris kitas failas, todėl pilnas failo dublikatas bendravardžiais eksportais vartui nematomas iš principo. Šis darbas paruošia logiką, kuri mato KELIUS, ne vardus.

## Agentai
PRIVALOMA grandinė: readme-guard -> debugger -> coder -> reviewer -> tester. readme-guard pirmas.

## Failai
Leidžiama:
- `src/tests/helpers/dead-export-gate-scan.ts`
- `src/tests/dead-export-gate-orphan-scan.test.ts`

Draudžiama:
- `src/tests/dead-export-gate.test.ts`
- `src/application/code-intelligence/store/code-index-store.ts`
- `src/infrastructure/index.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `dead-export-gate-scan.ts`: eksportuoti (a) `collectImportSpecifiers(source: string): string[]` — iš teksto ištraukia `import ... from "..."`, `export ... from "..."` ir dinaminius `import("...")` specifikatorius; (b) `resolveSpecifier(fromRelative: string, specifier: string): string | undefined` — santykinius `./`/`../` kelius verčia repo-santykiniais `.ts` keliais (`.js` sufiksas ESM importe → `.ts`), ne-santykinius grąžina `undefined`; (c) `findOrphanFiles(files: ReadonlyArray<{ relative: string; source: string }>, entrypoints: ReadonlySet<string>): string[]` — grąžina produkcinius (ne `tests/`) failus, kurių kelio nemini nė vieno KITO failo specifikatoriai ir kurių nėra `entrypoints`.
- SVARBI SKIRTIS: failų lygiui `export ... from "./x.js"` YRA importas (barrel'io taikinys nėra našlaitis) — priešingai nei simbolių patikroje, kur re-eksportai ignoruojami.
- `dead-export-gate-orphan-scan.test.ts`: savipatikra vien sintetiniais įėjimais (jokio FS) — (1) našlaitis su bendravardžiais eksportais → randamas; (2) failas, pasiekiamas TIK per `export * from` barrel → NErandamas; (3) entrypoint sąraše → NErandamas; (4) `tests/` failai neskaičiuojami kandidatais.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios, ir sustok. Nekeisk `dead-export-gate.test.ts` — realaus medžio skenavimas ir `KNOWN_ENTRYPOINTS` yra sekančios užduoties darbas.

## Neįtraukta
- Varto prijungimas prie realaus FS ir `KNOWN_ENTRYPOINTS` sąrašas (sekanti užduotis)
- `src/infrastructure/persistence/code-index-store.ts` trynimas — patikrinta 2026-09-02: failo medyje NĖRA, jo kelio nemini joks src failas (ALREADY_IMPLEMENTED)
