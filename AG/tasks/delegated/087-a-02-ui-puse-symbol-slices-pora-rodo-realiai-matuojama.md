## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
AG/openspec/changes/verqestra-backlog-v1/

## Tikslas
UI pusėje užtikrinti, kad `symbol_slices` vėliava nebebūtų amžinai „unmeasured". `FEATURE_PAIR_SELECTORS` (`src/interfaces/http/ui-compression-view.ts:265`) ima porą iš `symbol_source_chars` vs `symbol_signature_chars` per `fixedFieldPair`, kuris reikalauja `raw > 0`. Patikrink realius `vq/logs/context-size.jsonl` įrašus ir ankstesnio rašytojo pusės task'o rezultatą: jei SIG režimu laukas neįvedamas, pakeisk porą į realiai egzistuojančius laukus; jei įvedamas — patikrink, kad pora dabar matuojasi, ir padenk testu.

## Agentai
PRIVALOMA grandinė (be praleidimų, readme-guard pirmas):
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-compression-view.ts`
- `src/tests/ui-compression-view.test.ts`

Draudžiama:
- `src/application/context-pack/assemble/tiers.ts`
- `src/application/context-pack/assemble/persist.ts`
- `src/application/context-pack/metrics.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: perskaityti rašytojo pusės task'o rezultatą ir kelis realius `vq/logs/context-size.jsonl` įrašus; nuspręsti, ar `symbol_slices` porai reikia kitų laukų, ar užtenka esamos, pagrindimą įrašyti į ataskaitą.
- Coder: pritaikyti sprendimą; `fixedFieldPair` kontraktas (`ui-compression-view.ts:245`) nesikeičia — keičiasi tik jam paduodama laukų pora.
- Tester: `src/tests/ui-compression-view.test.ts` tvirtina, kad SIG režimo mėginys duoda matuojamą `symbol_slices` porą, o kitų keturių vėliavų suvestinės nepakito.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. SUSTOK ir klausk, jei teisingam poros matavimui prireiktų keisti `ContextSizeSample` schemą arba rašytojo pusę — tai jau kito scope darbas.

## Neįtraukta
Rašytojo pusės (`tiers.ts`/`persist.ts`) matavimo keitimas. `CONTEXT_CACHE_VERSION` kėlimas. Tier parinkimo ir kompresijos elgsenos keitimas. `worker_prompt_chars` — task 086.
