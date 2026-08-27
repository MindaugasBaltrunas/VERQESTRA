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
- `AG/openspec/changes/auto-032-shadow-matuoja-prompta-kuri-worker-realiai-gau/spec.md`

## Tikslas
`decideCompression` sprendimą priima pagal prompt'o lygio shadow porą, kai ji mėginiuose YRA; kai nėra — lieka dabartinis elgesys (fallback, ne lūžis). Slenksčio logika nesikeičia.

## Agentai
Privaloma grandinė: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-compression-view.ts`
- `src/tests/ui-compression-view.test.ts`

Draudžiama:
- `src/application/context-pack/metrics.ts`
- `src/application/context-pack/assemble/persist.ts`
- `ui-app/**`
- `AG/**`
- `vq/**`

## Veiksmas
- `decideCompression` skaito naujus prompt'o lygio laukus, kai jie mėginyje yra; kai nėra — grįžta prie dabartinės poros be lūžio.
- `MIN_DECISION_SAMPLES` ir spaudimo lygių slenksčiai lieka nepakeisti.
- Verdikto rezultate matomas laukas, kuris pora buvo naudota, kad UI galėtų įvardyti KAS lyginama.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei fallback'as reikalautų keisti slenksčių semantiką arba lūžtų esami skaitytojai.

## Neįtraukta
- Telemetrijos laukų rašymas (ankstesnis task'as).
- UI sakiniai `ui-app` (kitas task'as).
