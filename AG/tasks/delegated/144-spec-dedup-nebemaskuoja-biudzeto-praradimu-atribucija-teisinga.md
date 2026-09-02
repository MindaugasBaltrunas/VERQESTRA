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
openspec/changes/verqestra-backlog-v1/ — RAG auditas 7 (2026-09-01), radinys R2 (P3).

## Tikslas
`spec_dropped_count` perdeda: `spec-phase.ts` `droppedCount` (dabar 186 eil.) sumuoja ir `duplicate` numetimus, nors lauko dokumentacija (77 eil.) sako „PRARASTŲ ref'ų skaičius" — dublikatas pagal apibrėžimą praradimas nėra. Metrika turi skaičiuoti `unresolved + dropped BE duplicate`; dok. 77 eil. lieka teisinga be perrašymo. Elgesys keičia pack'o turinį, tad pagal CLAUDE.md „Pack'o semantika ir kešas" keliama `CONTEXT_CACHE_VERSION` 10 → 11 — tai VIENINTELIS šios grandinės kėlimas, istorijos įrašas apima ir tolesnį 144-b dedup klasifikacijos taisymą.

Žingsnis 0: jei `droppedCount` jau filtruoja `duplicate` IR versija jau 11 — ALREADY_IMPLEMENTED, cituok abi vietas ir testą kaip įrodymą.

## Agentai
Privaloma grandinė (nekeisti tvarkos): readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/spec-phase.ts`
- `src/application/context-pack/context-cache-model.ts`
- `src/tests/context-pack-spec-dropped-count.test.ts` (naujas; vardas numatomas, jei projekto konvencija diktuoja kitą — pasirink artimiausią, bet NEnaudok jau esamų testų failų)
- `src/tests/context-pack-guards.test.ts`

Draudžiama:
- `src/application/code-intelligence/retrieval/spec-fragments.ts` (144-b scope)
- `src/tests/code-intelligence.test.ts` (144-b scope)
- `src/tests/context-pack-rag-audit-4.test.ts` (144-b scope)
- `src/tests/context-pack-assemble.test.ts` (101 scope)
- `src/application/context-pack/context-cache-key.ts` (143 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `spec-phase.ts`: `droppedCount` skaičiuoja `unresolved + dropped BE duplicate`; `duplicate` numetimai lieka `spec_fragment_warnings`, bet iš praradimų metrikos iškrenta.
- `context-cache-model.ts`: `CONTEXT_CACHE_VERSION` 10 → 11 su istorijos įrašu „11 — …", kuriame nurodyta, kodėl senas įrašas meluotų (kitas `spec_dropped_count` ir kitos `spec_fragment_warnings` eilutės tam pačiam task'ui).
- Testai: naujame faile — `droppedCount`/`spec_dropped_count` su `duplicate` numetimu nepadidėja, o `unresolved`/`char_budget` numetimai skaičiuojami; `context-pack-guards.test.ts` versijos pin'as (196-200 eil.) atnaujinamas į 11.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei `droppedCount` filtravimui reikėtų keisti numetimo priežasties tipą taip, kad jis pasklistų už šių failų (pvz. į `context-pack-schema.ts`).

## Neįtraukta
- Dedup klasifikacija pagal nekirptą turinį ir fazės 1 ref'ų dedup (`spec-fragments.ts`) — 144-b.
- `MAX_SPEC_RETRIEVAL_WARNINGS` lubų dydis ir `WARNING_SEVERITY` tvarka — nekvestionuojami.
