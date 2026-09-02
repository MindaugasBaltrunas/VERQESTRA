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
- 101-discovered-docs-prijungti-su-cache-tapatybe-arba-pasalinti (A dalis: determinizmas + architekto verdiktas „prijungti")

## Tikslas
Discovered docs prijungimui reikia cache tapatybės: jei `CONTROL_DOC_ROOTS` medžio turinys pasikeičia, o cache raktas to nemato, cache hit tyliai grąžina pasenusį discovered tekstą. Šis task'as sukuria TIK šaltinių rinkimo modulį (be jokio wiring'o) pagal esamą `compression-cache-sources.ts` pavyzdį: funkcija, grąžinanti `ContextCachePort.collectSources` suderinamą kelių/šaltinių rinkinį iš kontrolinių dokumentų šaknų.
Žingsnis 0: jei `src/application/context-pack/discovered-docs-cache-sources.ts` jau egzistuoja ir turi testą — ALREADY_IMPLEMENTED su Glob/Grep citata.
Jei šaltinių rinkimas natūraliau gula į esamą modulį be naujo failo — sustok ir pasiūlyk, nekurk failo „dėl formos".

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/context-pack/discovered-docs-cache-sources.ts`
- `src/tests/context-pack-discovered-docs-cache-sources.test.ts` (numatomas vardas)

Draudžiama:
- `src/application/context-pack/assemble/assemble.ts`
- `src/application/context-pack/context-cache-model.ts`
- `src/application/code-intelligence/retrieval/discovered-docs.ts`
- `src/infrastructure/persistence/context-cache-store.ts`
- `src/application/policy-governance/context-selection-policy.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Perskaityk `src/application/context-pack/compression-cache-sources.ts` ir pakartok jo formą: gryna funkcija, IO tik per jau esamus portus, be naujų priklausomybių.
- Įgyvendink šaltinių rinkimą iš kontrolinių dokumentų šaknų taip, kad bet kurio dokumento turinio pasikeitimas pakeistų grąžinamą rinkinį; tvarka deterministinė (sort prieš ribojimą).
- Testas: tas pats medis duoda tą patį rinkinį; pakeitus vieno dokumento turinį rinkinys skiriasi; tuščia šaknis nemeta klaidos.

## Patikra
- `pnpm test`

## Stop
- Sustok, jei prireiktų keisti `ContextCachePort.collectSources` kontraktą — šaltiniai pridedami kvietėjo pusėje.
- Sustok, jei prireiktų liesti `assemble.ts` arba `CONTEXT_CACHE_VERSION` — tai 101-c scope.
- Commit'ink tik po žalio `pnpm test`.

## Neįtraukta
- Modulio prijungimas prie `cacheSources` (task 101-c).
- `CONTEXT_CACHE_VERSION` kėlimas (task 101-c).
