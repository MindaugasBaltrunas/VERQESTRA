# Task
## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Audito docs/audits/full-audit-2026-09-05.md P2 35: `task-classification-policy.json` `_comment` lauke nurodyti etalono kodo keliai (`policy/task-classification.ts`, `policy/route-model.ts`, `domain/tasks/human-review.ts`), kurie neegzistuoja VERQESTRA. Pakeisti į realius VERQESTRA kelius, nekeičiant `pathIncludes` reikšmių.

## Agentai
readme-guard -> documenter

## Failai
Leidžiama:
- `templates/vq/config/task-classification-policy.json`

Draudžiama:
- `src/domain/policies/task-classification-defaults.ts`
- `src/domain/policies/task-classification.ts`
- `templates/vq/config/agents.json`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `task-classification-policy.json` `_comment` lauke pakeisti etalono kelius į VERQESTRA kelius: `src/domain/policies/task-classification.ts`, `src/application/token-governance/route-model.ts`, `src/domain/tasks/human-review/gates.ts`.
- NEKEISTI jokių `pathIncludes` reikšmių (`src/commands/`, `src/orchestrator/`, `AG/orchestrator/src/core/` ir kt.) — `src/domain/policies/task-classification-defaults.ts` (draudžiama, domain scope) šiuo metu turi TUOS PAČIUS kelius; keitimas tik vienoje pusėje sulaužytų `_comment` deklaruojamą „veidrodis" invariantą tarp konfigo ir kodo default'o.
- Paleisti patikras, commit'inti tik jei žalios.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink tik pakeitus `_comment`. Jei kyla noras keisti `pathIncludes` (kad atitiktų realius VERQESTRA modulius) — STABDYK ir eskaluok: tai reikalauja `src/domain/policies/task-classification-defaults.ts` kodo pataisos, kuri yra domain scope ir už šio task'o `## Failai` ribų. Įrašyk šią pastabą į ataskaitą kaip atvirą radinį kitam task'ui.

## Neįtraukta
- `pathIncludes` reikšmių keitimas — reikalauja domain scope kodo pataisos (`task-classification-defaults.ts`), atskiras task'as.
- `vq/config/` vs `AG/config/` neatitikimas tarp JSON `feature.pathIncludes` ir defaults.ts — paminėti ataskaitoje, nekeisti.
