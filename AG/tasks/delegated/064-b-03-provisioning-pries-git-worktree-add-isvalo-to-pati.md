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
Pašalinti kolizijos sufikso priežastį: `inspectTaskWorktree` negyvą registraciją (katalogo nebėra) siunčia į karantiną su `prunable`, o `git worktree prune` užrakintos registracijos nebešalina — nauja registracija gauna kolizijos sufiksą. Negyva registracija turi būti išvalyta prieš `git worktree add`, ne užrakinta.

## Agentai
Privaloma grandinė (šia tvarka, be praleidimų): `readme-guard -> architect -> coder -> reviewer -> tester`.

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-provision.ts`
- `src/tests/infrastructure-worktrees.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-registration-cleanup.ts`
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts`
- `src/application/**`
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Veiksmas
- `createTaskWorktree` prieš `git worktree add` kviečia `cleanupWorktreeRegistrations` iš `worktree-registration-cleanup.ts`, kai `inspectTaskWorktree` grąžina karantiną vien tik dėl `prunable` priežasties.
- Po valymo pakartok `inspectTaskWorktree`; jei būsena tapo `absent`, tęsk įprastą `add` kelią be sufikso; visos KITOS karantino priežastys lieka nepaliestos (jokio automatinio `remove --force`).
- Testas `infrastructure-worktrees.test.ts` įrodo: negyva registracija prieš `add` išvaloma ir nauja kopija gauna vardą be kolizijos sufikso, o gyva nešvari kopija vis dar keliauja į karantiną.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok ir klausk, jei pakeitimas reikalautų susilpninti karantino invariantą arba keisti `CreateWorktreeResult` kontraktą.

## Neįtraukta
Gyvų lock'ų arbitražas tarp lygiagrečių vaiko git komandų. Preserved ref'ų valymas (063 scope).
