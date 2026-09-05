# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `docs/getting-started.md` 6 skyriaus pastraipa apie auto-push sako, kad jis ĮJUNGTAS
(`auto_push_enabled: true` šablone ir kodo default'e) ir nurodo, kaip išjungti —
ALREADY_IMPLEMENTED: cituok pastraipą.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-Dk1 (2026-09-05, patikrinta ✓),
`audit-docs.md` 13: `docs/getting-started.md:83-86` — „**Auto-push šiame repo IŠJUNGTAS**
(`vq/config/git-automation-policy.json`, `auto_push_enabled: false`)". Realybė: runtime
`vq/config/git-automation-policy.json:3` = `true`, šablonas
`templates/vq/config/git-automation-policy.json:3` = `true`, kodo default
`src/application/policy-governance/git-automation-policy.ts:28` = `true`; Stop hook'as
(`src/interfaces/hooks/on-stop.ts:440`) push'ina. Operatorius, pasitikėjęs dokumentu, mano, kad
Stop tik commit'ina lokaliai ir atšaukiama — o push'as jau įvykęs. Tai žalingiausias getting-started
teiginys: literaliai klaidingas ir su negrįžtama pasekme. Taisoma dokumentacija pagal kodą, ne
atvirkščiai — politikos pakeitimas yra operatoriaus sprendimas.

## Agentai
readme-guard -> documenter

## Failai
Leidžiama:
- `docs/getting-started.md`

Draudžiama:
- `templates/vq/config/git-automation-policy.json`
- `src/application/policy-governance/git-automation-policy.ts`
- `src/interfaces/hooks/on-stop.ts`
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `docs/getting-started.md:83-86`: perrašyti pastraipą — auto-push ĮJUNGTAS pagal nutylėjimą
  (`auto_push_enabled: true` šablone ir kodo default'e); Stop hook'as po commit'o push'ina į
  remote; išjungti — `vq/config/git-automation-policy.json` `auto_push_enabled: false`
  (vienos eilutės pakeitimas); iki tol commit'as NĖRA vien lokalus ir `git reset` jo neatšaukia
  remote'e.
- Kitų šio failo eilučių NEKEISTI (39-40 „exit 2" ir 81 Stop eilutė — task 222).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
- Politikos default'o keitimas į `false` — operatoriaus sprendimas, ne dokumentacijos task'as.
- `docs/getting-started.md:39-40` („exit 2", realiai 1) ir `:81` Stop eilutė — task 222.
