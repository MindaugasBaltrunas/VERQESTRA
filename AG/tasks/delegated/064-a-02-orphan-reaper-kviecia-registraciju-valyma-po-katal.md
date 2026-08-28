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
Prijungti `cleanupWorktreeRegistrations` (iš `worktree-registration-cleanup.ts`) prie `orphan-worktree-reaper.ts` eskalacijos kelio, kad po katalogo/šakos šalinimo neliktų negyvos registracijos su pakibusiu `index.lock`.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts`
- `src/tests/infrastructure-worktrees.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-registration-cleanup.ts`
- `src/infrastructure/git/worktrees/worktree-provision.ts`
- `src/application/**`
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Veiksmas
- `escalateOrphanRemoval` (orphan-worktree-reaper.ts, ~155 eil.) plikos `git worktree prune` vietoje kviečia `cleanupWorktreeRegistrations` iš `./worktree-registration-cleanup.js`.
- Nesėkmingas valymas (grąžintas `error` laukas) virsta matoma žurnalo eilute `ORPHAN …` stiliuje; reaper toliau NEMETA ir neblokuoja loop'o.
- Teste įrodyti: po reap'o negyva registracija su stale `index.lock` pašalinta, o gyva registracija nepaliesta.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok, jei `orphan-worktree-reaper.ts` viršytų 500 eilučių ribą arba reikėtų keisti `reapOrphanWorktrees` public kontraktą.

## Neįtraukta
Provisioning pre-check prieš `git worktree add` (kita užduotis). Paties valymo primityvo (`worktree-registration-cleanup.ts`) keitimas. Normalaus (ne-eskalacijos) reap kelio `pruneWorktrees` (worktree-reaper.ts) prijungimas — už scope ribų.
