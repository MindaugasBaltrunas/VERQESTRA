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
openspec/changes/verqestra-backlog-v1/

## Tikslas
Patvirtinti, kad bootstrap testas įrodo: config katalogas su `tool-budget.json` ir įdėtu pakatalogiu atsiranda worktree kopijoje, o `local.env` paritetas išlieka. Jei taip — ALREADY_IMPLEMENTED be rašymų.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/tests/worktree-runtime-bootstrap.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-runtime.ts`
- `src/composition/loop/command.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Patikrink, ar yra testas, kuris su `configDirs` sukuria config katalogą su `tool-budget.json` ir įdėtu pakatalogiu bei tvirtina, kad abu atsirado kopijoje.
- Patikrink, ar `local.env` per `configFiles` vis dar padengtas atskiru tvirtinimu.
- Jei abu punktai tenkinami — ataskaitoje rašyk ALREADY_IMPLEMENTED ir nieko nekeisk; jei ne — pridėk trūkstamą testą šiame faile.

## Patikra
- `pnpm test:file dist/tests/worktree-runtime-bootstrap.test.js`
- `pnpm test:only`

## Stop
Jei ALREADY_IMPLEMENTED — sustok be commit'o. Jei buvo pakeitimų — commit'ink tik kai abi patikros žalios, tada sustok.

## Neįtraukta
Produkcinio kodo keitimas; AG/config; benchmark provisioning kelias.
