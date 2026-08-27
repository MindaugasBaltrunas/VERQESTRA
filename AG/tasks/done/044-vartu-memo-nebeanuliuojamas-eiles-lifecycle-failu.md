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
`gates-memo-store.identify` `tree` hash'as nebeanuliuojamas nuo orkestratoriaus lifecycle failų. Šiuo metu vienas task failo perkėlimas tarp `AG/tasks` bucket'ų keičia viso worktree hash'ą, memo prašauna ir stop guard'as suka pilną ~4 min suite lygiagrečiai su dispatch'u.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/process/gates-memo-store.ts`
- `src/tests/process-gates-memo-store.test.ts`

Draudžiama:
- `src/application/quality-gates/quality-gates.ts`
- `src/interfaces/hooks/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Laikino indekso konstrukcijoje iš `tree` hash'o pašalink baigtinį lifecycle kelių sąrašą: `AG/tasks/**`, `AG/state/**`, `AG/logs/**`. Sąrašas fail-closed — jokių kitų kelių; `AG/openspec/**` ir `AG/benchmark/**` LIEKA hash'e.
- Architektas sprendžia realizaciją (nepridėti kelių į `git add` vs pathspec exclude po `write-tree`); abiem atvejais privalo išlikti determinizmas ir savybė „untracked produkto failai `src` viduje ĮEINA į hash'ą".
- Testai `process-gates-memo-store.test.ts`: (1) failo perkėlimas `AG/tasks` viduje NEkeičia tapatybės; (2) `src` arba `ui-app` failo pakeitimas keičia; (3) untracked failas `src` viduje keičia.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei sprendimas imtų reikalauti plėsti išimčių sąrašą už trijų įvardintų kelių arba keisti memo `schema_version` semantiką — tai operatoriaus sprendimai.

## Neįtraukta
- `gates-memo.ts` tapatybės komentaro atnaujinimas ir `quality-gates.test.ts` regresijos patikra — atskira nuosekli užduotis.
- Stop guard'o srautas (`stop-guards.ts`) ir UI testų timeout kalibracija.
- Vartų bėgimo serializacija tarp stop guard'o ir dispatch'o.
