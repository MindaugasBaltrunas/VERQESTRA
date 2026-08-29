# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 GeoGravity audito radinys — 15 preserved ref'ų, 14 be jokio state įrašo

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 075-preserved-ref-retencija-ir-hooks-log-archyvas

## Žingsnis 0 — ar jau įgyvendinta?
Jei egzistuoja preserved ref↔state sutaikinimo praėjimas (arba CLI
komanda), kuris kiekvienam `refs/verqestra/preserved/<sha>` be
atitinkamo `rollback-preserved/<task>.json` įrašo atkuria/įrašo state
metaduomenis (task id, base head, paths, data) arba pažymi ref'ą
retencijos kandidatu — ALREADY_IMPLEMENTED.

## Tikslas
GeoGravity 2026-08-29 auditas: 15 preserved ref'ų, iš jų 14 — našlaičiai
be jokio state įrašo. Priežastis: `rollback-preserved/<task>.json` rašomas
į LOKALŲ runtime (dažnai — worktree kopijos vq/state, kuris miršta kartu
su kopija arba yra gitignored), o ref'as gyvena bendrame .git — jie
išsiskiria po pirmo valymo. Be state įrašo ref'as tampa beveidis: 075
retencija negali nuspręsti, ar jį saugoti, o operatorius darbo vertę
atkuria tik git archeologija (2026-08-28/29 rankinis 6 taskų recovery —
kelios valandos žmogaus darbo).

Taisymas:
1. Preserved įrašo METADUOMENYS rašomi kartu su ref'u į PATVARIĄ vietą
   (pirminio medžio runtime root, ne kopijos) — task id, base head,
   paths sąrašas, sukūrimo laikas, run id.
2. Sutaikinimo praėjimas (loop starto metu arba `verqestra` komanda):
   ref be state įrašo → bandoma atkurti metaduomenis iš commit'o
   (žinutė, diff paths, data) ir įrašyti; nepavykus — ref žymimas
   `unattributed` su log eilute, retencijai perduodamas kaip kandidatas.
3. UI/status komandoje matomas preserved darbų sąrašas su task id ir
   apimtimi (kiek failų/eilučių) — kad neintegruotas darbas būtų MATOMAS,
   ne archeologuojamas.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/` (rollback preserve kelias)
- `src/infrastructure/git/` (ref'ų enumeracija/atributacija)
- `src/interfaces/cli/` (status/sutaikinimo komanda, jei ten gimsta)
- `src/tests/`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**` (UI vaizdas — 065 scope)

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Ref'ų trynimo politika (075 retencijos scope). Automatinis preserved
darbo atkūrimas/užbaigimas (063 scope). Dashboard vaizdas (065).
