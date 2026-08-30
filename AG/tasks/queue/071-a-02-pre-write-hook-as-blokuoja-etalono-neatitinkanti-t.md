# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Prijungti jau egzistuojantį `validateTaskAgainstEtalonas` prie PreToolUse rašymo šakos: rašymas į `AG/tasks/{queue,active,delegated}/*.md`, kuris pažeidžia etalono struktūrą, BLOKUOJAMAS su konkrečia taisyklės žinute. Reikalauja, kad `src/domain/tasks/etalonas-rules.ts` jau būtų sukurtas — jei jo nėra, stop ir klausk.

## Agentai
Privaloma grandinė, būtent šia tvarka: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/interfaces/hooks/pre-hooks.ts`
- `src/tests/interfaces-hooks-pre-hooks.test.ts`

Draudžiama:
- `src/domain/tasks/etalonas-rules.ts`
- `src/interfaces/hooks/scope-guards.ts`
- `src/application/quality-gates/preflight-rules.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: kur Write/Edit grandinėje įsiterpia bucket'o atpažinimas (`queue`, `active`, `delegated`) ir kaip žinomų task id sąrašas pasiekia gryną taisyklių funkciją per esamus `PreHookPorts` — be naujo `infrastructure` importo į `interfaces`.
- Coder: pažeidimas grąžinamas kaip blokas su `PRE_TOOL_BLOCK_EXIT_CODE`, žinutėje — pažeista taisyklė ir etalono kelias; `AG/tasks/examples/**`, `done/**`, `human-review/**` praleidžiami be validacijos.
- Tester: blokavimo atvejis kiekvienai taisyklei, praleidimo atvejis trims nevaliduojamiems bucket'ams ir suderinamumo testas — visi esami `AG/tasks/queue` ir `AG/tasks/active` failai praeina.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei esamas queue arba active task'as nepraeina naujos taisyklės — failo taisymas arba taisyklės švelninimas yra atskiras sprendimas, ne šio darbo dalis.

## Neįtraukta
Taisyklių turinio keitimas `etalonas-rules.ts` (ankstesnis darbas). 070 preflight varto pusė ir generatorių prompt'ai. Esamų queue failų taisymas.
