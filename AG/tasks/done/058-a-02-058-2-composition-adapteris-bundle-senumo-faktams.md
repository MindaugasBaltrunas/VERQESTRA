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
Surišti ankstesnėje dalyje deklaruotą bundle portą su tikru fs adapteriu: `ui-app/dist/index.html` mtime ir naujausio `ui-app/src` failo mtime.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/ui/router-adapters.ts`
- `src/tests/composition-ui-bundle-staleness.test.ts` (naujas)

Draudžiama:
- `src/interfaces/**`
- `src/application/**`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Jei `router-adapters.ts` jau tiekia bundle mtime faktus — ALREADY_IMPLEMENTED, sustok.
- Įgyvendink adapterį: skaityk `ui-app/dist/index.html` mtime ir rekursyviai naujausią `ui-app/src` failo mtime; trūkstamas kelias grąžina `null`, o ne meta klaidą.
- Teste padenk tris atvejus: bundle šviežias, bundle pasenęs, bundle nesukurtas.

## Patikra
- `pnpm typecheck && pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei paaiškėja, kad portas ankstesnėje dalyje nedeklaruotas.

## Neįtraukta
UI view laukai (jau padaryti), rebuild endpoint'as, rebuild proceso wiring, UI mygtukas (058-b).
