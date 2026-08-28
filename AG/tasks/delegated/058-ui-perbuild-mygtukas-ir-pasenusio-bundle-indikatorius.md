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
openspec/changes/verqestra-backlog-v1

## Tikslas
UI view atsakyme atsiranda bundle senumo faktai: `bundle_built_at` ir `bundle_stale`. Efektai gaunami per naują portą (interfaces sluoksnyje jokio `node:fs`). Tikras fs adapteris — atskira sekanti užduotis.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-router-model.ts`
- `src/interfaces/http/ui-router.ts`
- `src/tests/interfaces-http-router.test.ts`

Draudžiama:
- `src/application/**`
- `src/composition/**`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Jei `ui-router-model.ts` jau turi `bundle_built_at` ir `bundle_stale` laukus — ALREADY_IMPLEMENTED, nieko nekeisk ir sustok.
- Deklaruok portą `UiRouterPorts` viduje (pvz. `bundle.readFacts()`), grąžinantį bundle mtime ir naujausio `ui-app/src` failo mtime; interfaces sluoksnyje jokio `node:` IO.
- UI view atsakyme grąžink `bundle_built_at` (ISO arba `null`) ir `bundle_stale` (src mtime > bundle mtime); portui nesant arba bundle nesant — `null` / `false`, be klaidos.

## Patikra
- `pnpm typecheck && pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei architect nuspręstų, kad reikia keisti `src/application/**` arba portą kelti į kitą sluoksnį.

## Neįtraukta
Tikras fs adapteris ir composition wiring, `POST /api/ui/rebuild` endpoint'as, rebuild proceso paleidimas, UI mygtukas / indikatorius / i18n / CSS (058-b).
