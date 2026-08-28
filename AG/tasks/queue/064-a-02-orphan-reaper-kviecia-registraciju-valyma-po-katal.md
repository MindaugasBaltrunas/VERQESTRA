# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Prijungti `worktree-registration-cleanup` primityvą prie našlaičių valymo kelio. Šiuo metu `ORPHAN REAPED` pašalina katalogą ir šaką, bet negyvos registracijos liekana su pakibusiu `index.lock` išlieka ir kaupiasi iki tol, kol numuša gyvą darbą.

## Agentai
Privaloma grandinė (šia tvarka, be praleidimų): `readme-guard -> architect -> coder -> reviewer -> tester`.

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
- `orphan-worktree-reaper.ts` po katalogo ir šakos šalinimo (vietoje dabartinio plikojo `git worktree prune`, eilutė ~155) kviečia registracijų valymo funkciją iš `worktree-registration-cleanup.ts`.
- Nesėkmingas valymas virsta matoma žurnalo eilute tame pačiame `ORPHAN …` stiliuje; reaper toliau NEMETA ir neblokuoja loop'o.
- Testas `infrastructure-worktrees.test.ts` įrodo: po reap'o negyvos registracijos su stale `index.lock` nebelieka, o gyva registracija nepaliesta.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok, jei `orphan-worktree-reaper.ts` viršytų 500 eilučių ribą arba reikėtų keisti `reapOrphanWorktrees` public kontraktą.

## Neįtraukta
Provisioning pre-check prieš `git worktree add` (kita užduotis). Paties valymo primityvo keitimas.
