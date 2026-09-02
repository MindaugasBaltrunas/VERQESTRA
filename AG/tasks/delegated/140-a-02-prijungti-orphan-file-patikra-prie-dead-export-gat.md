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

## Priklausomybės
- 140-dead-export-gate-mato-pilnai-naslaicius-failus

> 2026-09-02 pataisyta: priklausomybė buvo proza apie helper'į, ne task id, tad planuoklė ją
> laikė `missing-dependency`. Helper'is `src/tests/helpers/dead-export-gate-scan.ts` jau yra
> (140 `done`); jei jame trūksta `collectImportSpecifiers` / `resolveSpecifier` /
> `findOrphanFiles` — sustok ir pranešk.

## Tikslas
Prijungti failų lygio našlaičių patikrą prie realaus `dead-export-gate.test.ts` varto: produkcinis src failas, kurio kelio neimportuoja nė vienas kitas src failas ir kuris nėra aiškiame entrypoint allowlist'e, yra pažeidimas `orphan-file`.

## Agentai
PRIVALOMA grandinė: readme-guard -> debugger -> coder -> reviewer -> tester. readme-guard pirmas.

## Failai
Leidžiama:
- `src/tests/dead-export-gate.test.ts`

Draudžiama:
- `src/tests/helpers/dead-export-gate-scan.ts`
- `src/tests/dead-export-gate-orphan-scan.test.ts`
- `src/application/code-intelligence/store/code-index-store.ts`
- `src/infrastructure/index.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `collect` (~208-232 eil.) papildomai išsaugo kiekvieno failo neapdorotą šaltinį arba jo specifikatorius per `collectImportSpecifiers`; naujas testas „gate: kiekvienas produkcinis failas turi importuotoją arba yra entrypoint" kviečia `findOrphanFiles` ir kiekvieną radinį praneša kaip `orphan-file` su failo vardu.
- `KNOWN_ENTRYPOINTS`: aiškus komentuotas sąrašas `KNOWN_UNCALLED` (~249-284 eil.) stiliumi — bent `cli.ts` (dist/cli.js yra bin ir hook'ų kvietimo taškas); kiekvienas kitas kandidatas TIK su priežasties komentaru, dviejų krypčių drausmė ta pati: atsiradęs importuotojas daro eilutę nebeteisingą.
- Failas privalo likti ≤ 500 eilučių (dabar 359) — jei netelpa, skenavimo dalį kelk į jau egzistuojantį helper'į, ne į naują failą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok ir klausk, jei patikra ras realių našlaičių, kurių trynimas nėra akivaizdžiai saugus (pvz. kelią mini konfigas ar ne-TS kodas) — tokio failo likimas yra operatoriaus sprendimas, ne baseline eilutė „kad praeitų". Tylus praleidimas draudžiamas.

## Neįtraukta
- Grynos skenavimo logikos ir jos savipatikros keitimas (ankstesnės užduoties scope)
- Bet kokių rastų našlaičių trynimas — sandbox trynimo neatlieka, reikia operatoriaus veiksmo
