# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Prijungti preserved work review verdiktą prie `verify-task` sprendimo: žalias išsaugotas darbas užbaigiamas kaip done su `PRESERVED-WORK-RECOVERED` žyma, raudonas — human-review su patikrų išvestimi ir preserved ref nuoroda.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/verify-task.ts`
- `src/tests/task-execution-run.test.ts`
- `src/tests/task-execution-verify-preserved.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`
- `src/infrastructure/**`
- `src/composition/**`

## Veiksmas
- `verify-task.ts` vietoje, kur iš `ROLLBACK PRESERVED` eilutės ištraukiamas `ref=`, iškviesk review use-case ir sprendimą priimk pagal jo verdiktą; portas paduodamas per parametrus (jei jo nėra — elgesys lieka kaip dabar).
- Žalias kelias grąžina done su `PRESERVED-WORK-RECOVERED` žyma commit žinutėje; raudonas — human-review priežastis papildoma patikrų uodega ir ref nuoroda.
- Testai: žalias preserved darbas → done su žyma; raudonas → human-review su uodega; preserved ref be turinio → human-review kaip dabar. Failai ≤ 500 eilučių — jei `verify-task.ts` peraugtų, iškelk šaką į atskirą modulį.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok, jei esamą preserved elgesį reikėtų keisti taip, kad senas testas silpnėtų.

## Neįtraukta
Composition surišimas — sekanti užduotis.
