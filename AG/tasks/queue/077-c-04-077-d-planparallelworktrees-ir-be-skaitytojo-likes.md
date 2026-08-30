# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Dvi infrastruktūros mirusio kodo vietos: (1) `planParallelWorktrees` (`worktree-layout.ts:98`) neturi nė vieno produkcinio kvietėjo — gyvas tik teste, šalinamas su testu; (2) `readWorktreeQuarantine` (`worktree-owner.ts:107`) yra write-only — karantino įrašai rašomi, bet niekas jų neskaito. PATIKSLINIMAS: `quarantineWorktree` NĖRA miręs (kvietėjai `worktree-removal.ts:131`, `worktree-reaper.ts:215,229`, `worktree-provision.ts:121`), tad šalinamas gali būti tik skaitytojas.

## Agentai
PRIVALOMA grandinė (ta pati eilės tvarka, be praleidimų): `readme-guard -> architect -> coder -> reviewer -> tester`.

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
- Architect: Grep'u įrodyti nulinį produkcinį `planParallelWorktrees` ir `readWorktreeQuarantine` kvietėjų skaičių; nuspręsti dėl karantino skaitytojo — šalinti ar prijungti prie orphan reaper'io ataskaitos — su pagrindimu ataskaitoje.
- Coder: pašalinti `planParallelWorktrees` ir architect'o nuspręstą karantino skaitytojo variantą; `quarantineWorktree` rašymo kelias NELIEČIAMAS.
- Tester: pašalinti `infrastructure-worktrees.test.ts:101` ir `:137` testus/importus, kurie liko be produkcinio atitikmens; likę worktree layout testai turi likti žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei architect nusprendžia karantino skaitytoją PRIJUNGTI — tam reikia `worktree-reaper.ts`, kuris yra už šio scope ribų.

## Neįtraukta
`quarantineWorktree` rašymo kelio keitimas. Orphan reaper'io ataskaitos plėtimas. Zombie `.git/worktrees/operator-restore-037a` valymas (rankinis operatoriaus veiksmas).
