# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 110-lt-datos-laukai-neberodo-dvieju-priestaraujanciu-formatu

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/model/dashboardViewModel.ts` jau turi gryną funkciją, kuri iš `UiWavesView` grąžina in-flight worker→task sąrašą (slots filtras + lease fallback), ir ji dengta testais — ALREADY_IMPLEMENTED: cituok funkciją ir testus.

## Tikslas
Sukurti gryną išvedimą, kuris iš JAU turimų `/api/waves` duomenų (`UiWavesView`, `ui-app/src/model/types.ts:765-849`) grąžina sąrašą, kas dabar vykdoma: worker_id → task_id. Tai pamatas kitam darbui, kuris šį sąrašą parodys apžvalgos suvestinėje ir Užduočių lentoje. Šiame darbe JOKIO UI ir jokio naujo duomenų kanalo.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/model/dashboardViewModel.ts`
- `ui-app/src/model/dashboardViewModel.test.ts`

Draudžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/components/WorkflowBoard.tsx`
- `ui-app/src/controller/useWavesController.ts`
- `ui-app/src/model/api.ts`
- `ui-app/src/model/types.ts`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Pridėk eksportuojamą gryną funkciją (pvz. `selectInFlightSlots`), kuri iš `UiWavesView` grąžina `{ worker_id, task_id }` įrašų sąrašą: pirmenybė `slots` (`state === "running"` IR `stale === false`); jei `slots` nėra (senas serveris, laukas optional) — fallback per `leases`; `null`/tuščias įėjimas grąžina tuščią sąrašą.
- Task id normalizuok kanoniškai per esamą `ui-app/src/model/taskFileLabel.ts` logiką arba failo vardo kamieną, kad vėliau būtų galima lyginti su kortelėmis (ne pilno kelio lygybė).
- Padenk testais: slots atranka (running/ne-running, stale/ne-stale), lease fallback be `slots`, tuščias ir `null` atvejai, id normalizacija.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei paaiškėtų, kad reikia keisti `types.ts` kontraktą arba kontrolerių kanalus — jie šiame task'e Draudžiami.

## Neįtraukta
- Apžvalgos suvestinės eilutė, `WorkflowBoard` badge, i18n raktai, CSS ir render testai — sekantis task'as.
- Bucket perėjimų darymas pagrindiniame medyje dispatch'o metu.
- `WavesPanel` (#/system) ir SSE `/api/events` pakeitimai.
