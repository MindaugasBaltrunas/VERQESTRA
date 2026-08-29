# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 073-registraciju-valymas-visuose-worktree-salinimo-keliuose
- 074-neintegruoto-w2-darbo-apsauga-po-proceso-luzio
- 078-worktree-bootstrap-buildstamp-ir-pnpm-path-spragos
- 079-orphan-valymas-iveikia-untracked-failus-ir-fs-liekanas
- 080-vaiko-exit-visada-palieka-diagnoze-ir-stderr

## Tikslas
Pajungti domain 'split' verdiktą prie vykdymo: vietoj trečio bandymo ar parkavimo human_review, pasikartojantis timeout kviečia `buildTaskSplitPlan`, tėvas žymimas superseded, vaikai dedami į queue tuo pačiu keliu, kurį naudoja preflight splitter'is, o žurnale atsiranda eilutė `TASK SPLIT (runtime-oversize): parent=<id> parts=<n> po <k> timeout`.

## Agentai
PRIVALOMA grandinė be praleidimų: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/run-coordinator.ts`
- `src/application/task-execution/run-coordinator-terminal.ts`
- `src/application/task-execution/human-review-escalation.ts`
- `src/tests/task-execution-runtime-split.test.ts`
- `src/tests/task-execution-orchestration.test.ts`

Draudžiama:
- `src/domain/**`
- `src/interfaces/**`
- `dist/**`
- `ui-app/**`

## Veiksmas
- Įterpti 'split' maršrutą PRIEŠ human_review eskalaciją: perpanaudoti esamą `buildTaskSplitPlan` -> `enqueue-child-tasks` kelią, jokio LLM kvietimo, jokio naujo porto.
- Tėvą pažymėti superseded ir įrašyti žurnalo eilutę su parent id, dalių skaičiumi ir timeout'ų skaičiumi.
- Testai `src/tests/task-execution-runtime-split.test.ts`: timeout×2 -> vaikai queue + tėvas superseded + žurnalo eilutė; timeout×1 -> repair kaip dabar; nedalomas taskas -> human_review; `src/tests/task-execution-orchestration.test.ts` esami scenarijai nepakitę.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai patikros žalios. Sustok ir pranešk, jei sprendimo taškas gyvena ne šiuose failuose arba jei žurnalo eilutė gimsta `src/interfaces/**` — tada įrašyk konkretų failą į ataskaitą kaip nukrypimą ir laukk sprendimo.

## Neįtraukta
LLM-pagrįstas skaidymas pagal sesijos progresą. Token biudžetų kėlimas. Istorinių jau suskaidytų taskų taisymas.
