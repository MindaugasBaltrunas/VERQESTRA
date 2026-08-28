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
Patvirtinti, kad worktree runtime bootstrap'as jau turi `configDirs` lauką ir kopijuoja jį rekursyviai (2026-08-28 GeoGravity lūžis „tool budget not found: <worktree>\vq\config\tool-budget.json"). Jei taip — ALREADY_IMPLEMENTED be rašymų.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-runtime.ts`

Draudžiama:
- `src/composition/loop/command.ts`
- `src/application/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Patikrink, ar `WorktreeRuntimeLayout` turi `configDirs?: readonly string[]` ir ar `configFiles` liko dėl suderinamumo.
- Patikrink, ar po `configFiles` ciklo yra rekursyvi katalogų kopija (`cp` su `recursive: true`, perrašanti idempotentiškai) ir ar nesantis šaltinio katalogas praleidžiamas švariai, be klaidos.
- Jei abu punktai tenkinami — ataskaitoje rašyk ALREADY_IMPLEMENTED ir nieko nekeisk; jei ne — pridėk trūkstamą dalį tik šiame faile.

## Patikra
- `pnpm typecheck`
- `pnpm lint`

## Stop
Jei ALREADY_IMPLEMENTED — sustok be commit'o. Jei buvo pakeitimų — commit'ink tik kai abi patikros žalios, tada sustok.

## Neįtraukta
Kompozicijos surišimas ir testų padengimas (atskiros nuoseklios užduotys); `.claude/agents` kopijavimas; AG/config; benchmark provisioning kelias.
