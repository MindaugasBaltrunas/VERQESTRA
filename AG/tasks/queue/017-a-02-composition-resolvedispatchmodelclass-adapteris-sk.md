# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Surišti `TaskRunPorts.policy.resolveDispatchModelClass` composition sluoksnyje: adapteris deterministiškai suskaičiuoja tą patį modelį, kurį `claude-dispatch` parinks per `resolveDispatchRoutingPlan`, kad biudžeto vartų verdiktas sutaptų su realiu paleidimu.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester. readme-guard eina pirmas ir grąžina ribų santrauką.

## Failai
Leidžiama:
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/composition/loop/coordinator-adapters.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `src/application/token-governance/route-model.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-routing-plan.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Realizuoti `resolveDispatchModelClass`: nuskaityti task tekstą, routing policy, project profile, task metrikas ir retry skaitiklius — tuos pačius įėjimus, kuriuos naudoja `resolveDispatchRoutingPlan`, ir grąžinti `routeModel` modelio klasę.
- Adapterio klaidą propaguoti kvietėjui (jis pats krenta atgal į decision modelį); jokio tylaus default'o adapteryje.
- Testas/patikra, kad adapteris ir dispatch kelias su tais pačiais įėjimais grąžina tą patį modelį (deterministiškumas), ir kad failas telpa į ≤500 eilučių ribą.

## Patikra
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros žalios ir vartų tikrinamas modelis sutampa su dispatch'inamu. Commitinti vienu commit'u su privaloma ataskaita. Jei sutapimui reikėtų keisti `routeModel` arba `dispatch-routing-plan.ts` — sustoti ir pranešti, nespręsti tyliai.

## Neįtraukta
- Routing taisyklių keitimas.
- Attempt rezoliucijos vielinimas (task 015).
- Queue loop vykdymas.
