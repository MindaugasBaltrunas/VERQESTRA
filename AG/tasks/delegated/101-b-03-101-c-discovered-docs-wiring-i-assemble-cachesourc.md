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
- 101-discovered-docs-prijungti-su-cache-tapatybe-arba-pasalinti
- 101-a-02-101-b-control-doc-roots-turinio-cache-saltiniu-mod

> 2026-09-02 pataisyta: abi priklausomybės buvo proza („(A dalis)", „101-b — …"), o ne
> task id, tad planuoklė jas laikė `missing-dependency` ir task'as nepateko į bangą (w2 stovėjo
> tuščias). Abu task'ai yra `done`.

## Tikslas
Užpildyti sąmoningai paliktą lizdą: `GraphFirstContextCandidates.docsSnippets` (`assemble.ts:238`) visada `[]`, nors atranka (`context-selection-policy.ts:133`) kibirą jau apdoroja. Šis task'as prijungia discovered docs prie surinkimo IR uždaro cache tapatybės sąlygą, be kurios prijungimas draudžiamas.
Žingsnis 0: jei `assemble.ts` jau importuoja `discoverControlDocCandidates` ir `docsSnippets` nebėra tuščias literalas — ALREADY_IMPLEMENTED su Grep citata (įskaitant cache šaltinių eilutes).

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/context-pack/assemble/assemble.ts`
- `src/tests/context-pack-assemble.test.ts`
- `src/application/context-pack/context-cache-model.ts` (TIK `CONTEXT_CACHE_VERSION`)
- `src/application/context-pack/context-pack-schema.ts` (tik jei architektas neša discovered tekstą pack'e)
- `src/application/context-pack/render-execution-context.ts` (tik jei naujas pack laukas renderinamas)
- `src/tests/context-pack-render-execution-context.test.ts` (numatomas vardas)

Draudžiama:
- `src/application/code-intelligence/retrieval/discovered-docs.ts`
- `src/application/context-pack/discovered-docs-cache-sources.ts` (tik importuojamas, nekeičiamas)
- `src/application/policy-governance/context-selection-policy.ts`
- `src/infrastructure/persistence/context-cache-store.ts`
- `src/tests/context-pack-cache-bypass.test.ts`
- `src/tests/context-pack-guards.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `assemble.ts`: `discoverControlDocCandidates` + `rankDiscoveredDocCandidates` + `selectDiscoveredDocs` rezultatai užpildo `candidateSet.docsSnippets` (238 eil.) ir keliauja į pack'ą architekto pasirinkta forma (schema/renderis keičiami tik jei ta forma to reikalauja).
- `assemble.ts`: 101-b modulio šaltiniai pridedami prie `cacheSources` (157-169 eil., po 097 pakeitimų), kad discovered teksto pasikeitimas anuliuotų cache įrašą; `CONTEXT_CACHE_VERSION` pakeliamas ir sprendimas užfiksuojamas ataskaitoje (CLAUDE.md „Pack'o semantika ir kešas").
- Testai `src/tests/context-pack-assemble.test.ts`: `docsSnippets` nebe tuščias, kai šaknyse yra kontrolinių dokumentų; pakeitus dokumento turinį cache raktas skiriasi (ne `hit`); be dokumentų elgesys nepakitęs.

## Patikra
- `pnpm test`

## Stop
- Sustok, jei prijungimas reikalautų silpninti biudžeto ar atrankos testus.
- Sustok, jei prireiktų keisti `ContextCachePort` kontraktą ar `context-selection-policy.ts`.
- Sustok, jei `CONTEXT_CACHE_VERSION` kėlimas nepakanka cache tapatybei — tai signalas, kad šaltiniai surinkti neteisingai.
- Commit'ink tik po žalio `pnpm test`.

## Neįtraukta
- Determinizmo pataisa ir docstring'ai `discovered-docs.ts` (A dalis).
- Cache šaltinių modulio įgyvendinimas (task 101-b).
