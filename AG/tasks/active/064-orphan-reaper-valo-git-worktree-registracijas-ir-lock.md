# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus pavedimu — 1179 (GeoGravity) 51 min w2 sesija žlugo dėl stale index.lock iš senų run'ų liekanų

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei orphan reaper (arba slot provisioning prieš `git worktree add`) šalina
negyvas `.git/worktrees/<name>/` registracijas (`git worktree prune`
ekvivalentas) IR stale `index.lock` failus mirusiose registracijose —
ALREADY_IMPLEMENTED.

## Tikslas
GeoGravity 2026-08-28: po septynių įveiktų kliūčių pirmoji PILNA w2 sesija
(1179, 51 min opus darbo kopijoje) žlugo finale, nes visos vaiko git
operacijos atsimušė į:

```text
fatal: Unable to create '.git/worktrees/w2-1179_...-a12/index.lock': File exists
```

Dvi priežastys: (1) `.git/worktrees/` pilnas negyvų registracijų iš
ankstesnių žlugusių run'ų (todėl nauja registracija gavo `-a12` kolizijos
sufiksą), (2) vienoje jų liko stale `index.lock` iš nužudyto git proceso.
`ORPHAN REAPED` šiuo metu šalina worktree KATALOGĄ ir šaką, bet ne git
registracijos liekanas — jos kaupiasi ir galiausiai numuša gyvą darbą.
Rollback'as tokioje būsenoje irgi krito (`rollback_failed=1`), tad 51 min
darbo nuėjo į human-review be jokios savo kaltės.

Taisymas:
1. Orphan reaper po katalogo/šakos šalinimo įvykdo registracijos valymą
   (`git worktree prune` arba tikslinį `.git/worktrees/<name>` šalinimą).
2. Slot provisioning prieš `git worktree add` patikrina, ar to paties vardo
   registracija negyva (katalogo nebėra) — jei taip, išvalo, kad nauja
   registracija negautų kolizijos sufikso.
3. Stale `index.lock` negyvoje registracijoje (procesas nebeegzistuoja)
   šalinamas valymo metu; GYVOS registracijos lock'as neliečiamas.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/`
- `src/application/scheduling/` (reaper kvietimo vieta)
- `src/tests/`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Gyvų lock'ų arbitražas tarp lygiagrečių vaiko git komandų (jei toks
konfliktas realus — atskiras tyrimas). Preserved ref'ų valymas (063 scope).
