# Task

## Spec source
openspec/changes/verqestra-backlog-v1/
docs/audits/021-rollback-preserve-design-2026-08-25.md

## Tikslas
Uždaryti operatoriaus kilpą: kai verify eina į rollback'ą be commit'o, human-review priežastyje privalo būti nurodyta, kur guli išsaugotas necommit'intas darbas.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/verify-task.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `src/infrastructure/**`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Po `rollback-stable` kvietimo perskaityk design'e nurodytą išsaugojimo įrašą per esamą portą ir įtrauk vietą į `TASK NOT DONE` priežastį.
- Kai išsaugojimo įrašo nėra, priežastis lieka tokia pat kaip dabar — jokio naujo tylaus kelio.
- Regresinis testas atkuria 018 seką: ledger'yje 2 nuosavi keliai, commit'o nėra, diagnosis done → priežastyje matoma darbo vieta, darbas neprarandamas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok, jei prireiktų naujo porto `application` sluoksnyje, kurio design'as neaprašo.

## Neįtraukta
- Coordinator bounded laukimas — atskiras darbas.
