# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Kompresijos puslapis rodo `compact_dsl=true` kaip „good", nors efektyvus konfigas vėliavą išjungia dėl `worker_task_ir=false`. Atvaizduoti serverio jau grąžinamą `inactive_reason` (žr. ankstesnę užduotį), kad operatorius matytų arešto priežastį išsaugojimo momentu.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `CompressionPage` neaktyviai vėliavai jau rodo įspėjimą ir badge nėra `status-good` — ALREADY_IMPLEMENTED, stok ir pranešk.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/model/types.ts`
- `ui-app/src/view/pages/CompressionPage.tsx`
- `ui-app/src/view/pages/CompressionPage.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `types.ts`: vėliavos tipui pridėk opcionalius `requires` ir `inactive_reason` laukus, atitinkančius serverio view atsakymą; puslapis jų NEperskaičiuoja.
- `CompressionPage.tsx`: kai `inactive_reason` yra — „Current" badge rodyk ne `status-good`, o `status-error`/neutral su tekstu „inactive", ir po hint'u pridėk įspėjimo eilutę apie tai, kad vėliava išsaugoma, bet neveikia; jungiklio NEblokuok.
- Nauji tekstai per `t(...)` ir `I18nContext.tsx` žodyną; kiekvienai naujai className pridėk taisyklę `dashboard.css` (`dashboard-css-coverage.test.ts` vartas). Puslapio testas: įspėjimas matomas tik neaktyviai vėliavai.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok, jei serverio view dar negrąžina `inactive_reason` — tada ši užduotis blokuota ankstesnės.

## Neįtraukta
Serverio view laukų skaičiavimas. Numanomas `worker_task_ir` įjungimas. Priklausomybių lentelės keitimas. `canary` per-task kohortos vertinimas.
