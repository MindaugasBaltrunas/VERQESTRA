# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus pavedimu — visą dieną w2 slot'o bėgimai (iki 51 min opus sesijos) buvo nematomi dashboard'e, diagnostika ėjo tik per orchestrator.log grep'us

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei dashboard'o „Darbo eigos suvestinė" (Workflow snapshot), „Aktyvus
vykdymas" (Active execution) ir „Pagrindiniai signalai" (Key signals)
rodo IR w2 slot'o būseną (task, worktree, gyvavimo trukmė, baigtis) —
ALREADY_IMPLEMENTED.

## Tikslas
GeoGravity 2026-08-28 patirtis: w2 slot'ai realiai dirbo (worktree
kopijose, iki 51 min opus sesijos), bet UI dashboard'as viso to nerodė —
„Aktyvus vykdymas" ir agentų grandinė atspindėjo tik primary-tree (w1)
kelią, o w2 gyvybės/lūžio faktus operatorius matė tik grep'indamas
orchestrator.log (`SLOT PROVISIONED`, `WAVE SLOT CHILD EXIT`,
`worker_integration_parked`). Backend'e duomenys JAU yra: worker lease'ai,
`interfaces/ui-model/wave-slot-model.ts` („vieno slot'o (worker lease)
būsena bangoje"), `interfaces/http/ui-waves-view.ts`, wave-events.jsonl.
Trūksta tik jų iškėlimo į pagrindinius dashboard'o blokus.

Reikalavimai:

1. **Darbo eigos suvestinė / agentų grandinė** (`AgentChainProgress` /
   `DashboardPage`): kai banga turi aktyvų w2 slot'ą, grandinės vaizde
   matoma antra lygiagreti juosta su w2 task'u ir jo faze (bootstrap /
   preflight / delegated / integracija) — ne tik w1 kelias.
2. **Aktyvus vykdymas** (`useAgentActivity` / DashboardPage sekcija):
   rodomi ABU aktyvūs slot'ai — worker id (w1/w2), task id, modelis,
   worktree kelias (w2 atveju), bėgimo trukmė.
3. **Pagrindiniai signalai** (`OverviewPanel`): nauji signalai —
   `w2: <task> (Xm)` kai gyvas; paskutinė w2 baigtis (`merged` /
   `parked: <priežastis>` / `child exit <kodas>`); bangos režimas
   (`sequential` / `parallel 2/2`).
4. Duomenys imami iš esamų šaltinių (lease store, wave snapshot,
   wave-events) per esamą ui HTTP sluoksnį — jokio naujo log parsinimo
   UI pusėje; jei ui-waves-view jau servuoja dalį, pirmenybė jam.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/components/` (AgentChainProgress, OverviewPanel, naujas
  slot komponentas jei reikia)
- `ui-app/src/controller/` (useAgentActivity ir susiję hook'ai)
- `ui-app/src/i18n/I18nContext.tsx` (nauji raktai lt vertimams)
- `ui-app/tests/` arba `ui-app/src/**/*.test.*` pagal esamą konvenciją
- `src/interfaces/http/` (tik jei w2 slot duomenų endpoint'as nepilnas)
- `src/interfaces/ui-model/` (tik projekcijos, be verslo logikos)
- `src/tests/`

Draudžiama:
- `src/application/scheduling/**` (planavimo logika nesikeičia — tik
  atvaizdavimas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: nustatyti, ką ui-waves-view jau servuoja ir ko trūksta
  dashboard'o trims blokams; UI tik projektuoja esamą būseną.
- Coder: w2 juosta grandinėje, abu slot'ai „Aktyvus vykdymas", trys nauji
  signalai „Pagrindiniai signalai" bloke; i18n raktai en+lt.
- Tester: komponentų testai — sequential režime UI identiškas dabartiniam
  (jokio tuščio w2 bloko); parallel režime abu slot'ai matomi; parked/exit
  baigtis rodoma su priežastimi.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Scheduling/provisioning elgsenos keitimas. Istorinių bangų archyvo vaizdas.
Mobile gateway. Naujų log formatų kūrimas (tik esami šaltiniai).
