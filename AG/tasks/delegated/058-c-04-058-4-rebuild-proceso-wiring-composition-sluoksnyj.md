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
Surišti `POST /api/ui/rebuild` portą su tikru proceso paleidimu tuo pačiu šablonu kaip loop start, kad endpoint'as veiktų gyvai.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/ui/lifecycle-adapters.ts`
- `src/composition/ui/router-adapters.ts`
- `src/tests/composition-ui-rebuild-wiring.test.ts` (naujas)

Draudžiama:
- `src/interfaces/**`
- `src/application/**`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Jei rebuild portas jau surištas — ALREADY_IMPLEMENTED, sustok.
- Surišk rebuild proceso paleidimą per esamą `ProcessLifecyclePorts` adapterį; komanda ateina iš interfaces, composition jos nekeičia ir nepriima iš request'o.
- Teste padenk: pirmas prašymas `started`, antras lygiagretus `already-running`, nesėkmė grąžina `failed` su išvesties uodega.

## Patikra
- `pnpm typecheck && pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei testui reikėtų realaus `pnpm build` paleidimo — spawn turi būti stub'inamas.

## Neįtraukta
UI mygtukas, indikatoriaus rodymas, i18n, CSS — 058-b. Automatinis perbuild'as po loop task'ų, websocket auto-reload.
