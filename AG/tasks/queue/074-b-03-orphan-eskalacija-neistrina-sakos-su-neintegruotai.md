# Task

## Spec source
openspec/changes/verqestra-backlog-v1 — audito P1 (2026-08-29): `escalateOrphanRemoval` po 24 h daro `git branch -D` ir sunaikina neintegruotus w2 commit'us, palikdamas tik `.patch` gitignore'intame `vq/`.

## Tikslas
Pridėti eskalacijos vartą: šaka, kurios commit'ų nėra pagrindinėje šakoje, negali gauti `branch -D` — vietoj to ji parkuojama operatoriui.

Žingsnis 0: jei `escalateOrphanRemoval` jau tikrina `merge-base --is-ancestor` prieš `branch -D` — ALREADY_IMPLEMENTED su eilučių įrodymu.

## Agentai
Privaloma grandinė: `readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester`. readme-guard pirmas.

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts`
- `src/tests/infrastructure-worktrees.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-branch-integration.ts`
- `src/application/scheduling/wave-snapshot.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `escalateOrphanRemoval` (~:126-176) prieš `git branch -D` (~:164) tikrina `git merge-base --is-ancestor <branch> <base>`; neigiamas atsakymas reiškia neintegruotus commit'us.
- Tokiu atveju šaka NEtrinama, o grąžinama kaip `worker_integration_parked` klasės rezultatas/žurnalo eilutė (funkcija nemeta — kaip esamas kelias); `.patch` archyvas lieka papildoma kopija.
- Testas: (a) neintegruoti commit'ai → park, jokio `-D`; (b) jau integruota šaka → elgesys nepakitęs.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei reikėtų keisti `reapOrphanWorktrees` public kontraktą arba failas viršytų 500 eilučių ribą.

## Neįtraukta
Snapshot ir scheduler pakeitimai (ankstesnės užduotys). Preserved ref'ų retencija (075). Orphan untracked failų valymas (079).
