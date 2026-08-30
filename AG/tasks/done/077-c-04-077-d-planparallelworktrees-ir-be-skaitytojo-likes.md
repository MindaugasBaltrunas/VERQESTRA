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
AG/openspec/changes/verqestra-backlog-v1

## Tikslas
Pašalinti du mirusio kodo taškus infrastructure/git/worktrees: planParallelWorktrees (worktree-layout.ts:98) neturi produkcinio kvietėjo; readWorktreeQuarantine (worktree-owner.ts:107) yra write-only skaitytojas. quarantineWorktree NELIEČIAMAS — jis turi gyvus kvietėjus.

## Agentai
PRIVALOMA grandinė be praleidimų: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-layout.ts`
- `src/infrastructure/git/worktrees/worktree-owner.ts`
- `src/tests/infrastructure-worktrees.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-reaper.ts`
- `src/application/scheduling/worker-pool-plan.ts`
- `src/tests/dead-export-gate.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Grep'u patvirtinti nulinį produkcinių kvietėjų skaičių abiem funkcijom prieš keičiant.
- Pašalinti planParallelWorktrees ir readWorktreeQuarantine eksportus bei jų testus (infrastructure-worktrees.test.ts:101 ir :137 blokus/importus); quarantineWorktree rašymo kelio neliesti.
- Įsitikinti, kad likę worktree layout testai lieka žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei paaiškėja, kad kuriai nors funkcijai vis dėlto yra produkcinis kvietėjas.

## Neįtraukta
quarantineWorktree rašymo kelio keitimas. Orphan reaper'io ataskaitos plėtimas. Zombie .git/worktrees/operator-restore-037a valymas (rankinis operatoriaus veiksmas).
