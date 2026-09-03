# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 137-apzvalgos-suvestine-rodo-gyva-w1-w2-darba-is-waves

> 2026-09-03 pataisyta: priklausomybė buvo proza („137 pirmoji dalis: in-flight
> išvedimas …"), ne task id, tad planuoklė ją laikė `missing-dependency` ir
> užblokavo bangą (`LOOP STOP: all-blocked`, 09:51). Tikrasis tėvas yra `done`.

## Žingsnis 0 — ar jau įgyvendinta?
Jei (1) `ui-app/src/view/pages/DashboardPage.tsx` apžvalgos blokas (`QueueSnapshot`, ~375-389 eil.) rodo in-flight eilutę iš waves duomenų IR (2) `ui-app/src/view/components/WorkflowBoard.tsx` kortelė su gyvo slot'o task id gauna „vykdomas" badge — ALREADY_IMPLEMENTED: cituok abiejų vietų JSX ir testus.

## Tikslas
Operatorius nemato, kad w1/w2 dirba: `QueueSnapshot` rodo tik pagrindinio medžio bucket'ų skaičius, o worktree izoliacijoje `queue→active` perėjimas vyksta tik kopijoje, tad `active` amžinai 0. Gyvi duomenys jau yra tame pačiame komponente (`DashboardPage.tsx:64-68` overview route vartoja `useWavesController` — vienintelis 30 s polling'as). Parodyk in-flight worker→task eilutę suvestinėje ir „vykdomas (w1/w2)" badge ant sutampančios `WorkflowBoard` kortelės, naudodamas ankstesnio task'o gryną išvedimą. Jokio naujo fetch kanalo.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai

> 2026-09-03 pataisyta ANTRĄ kartą: trys iš šešių kelių buvo iš prieš-pertvarkymo
> ui-app išdėstymo (`view/components/WorkflowBoard.tsx`, `src/dashboardSmoke.test.tsx`).
> Vykdytojas dirbo teisinguose failuose, o diagnozė pamatė
> `changed files outside allowed paths` ir parkavo (12:58). Keliai žemiau patikrinti
> Glob'u prieš įrašant. `dashboard.css` pakeistas į `09-workflow.css`: nuo 2026-09-03
> `dashboard.css` yra tik `@import` rodyklė, o `.running-now` gyvena 09-workflow.

Leidžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/tests/app/dashboardSmoke.test.tsx`
- `ui-app/src/view/components/dashboard/WorkflowBoard.tsx`
- `ui-app/src/tests/view/components/dashboard/WorkflowBoard.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/09-workflow.css`

Draudžiama:
- `ui-app/src/model/dashboardViewModel.ts`
- `ui-app/src/model/dashboardViewModel.test.ts`
- `ui-app/src/controller/useWavesController.ts`
- `ui-app/src/model/api.ts`
- `ui-app/src/view/components/WavesPanel.tsx`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `DashboardPage.tsx`: jau turimus `waves` duomenis paleisk per ankstesnio task'o gryną išvedimą ir perduok į apžvalgos bloką — in-flight eilutė rodo worker → task poras; tuščias sąrašas, `null` ar waves klaida = suvestinė atrodo kaip iki šiol, be „0 vykdoma" ir be klaidos triukšmo. Ten pat `wavesEnabled` (~67 eil.) papildyk `"tasks"` route — vienas polling kanalas trims vartotojams (64-66 eil. komentaro taisyklė lieka).
- `WorkflowBoard.tsx`: priimk worker→task žemėlapį per props iš `DashboardPage` ir kortelei, kurios kanoninis task id sutampa, pridėk matomą „vykdomas (w1)" badge. TIK vizualinis žymuo: stulpeliai, bucket skaičiai ir perkėlimo veiksmai nekinta.
- i18n ir CSS: nauji raktai su EN sentinelėmis ir LT vertimais (task id neverčiami), naujoms klasėms — taisyklės `dashboard.css` (CSS dengiamumo vartas). Testai: render su gyvu w1/w2 slot'u rodo worker→task eilutes ir badge (LT ir EN), be sutapimo badge nėra, esami QueueSnapshot/bucket/`workflow-card--<name>` testai žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei waves duomenys apžvalgos ar tasks route'e nepasiekiami be `useDashboardController`/`useWavesController` kontraktų keitimo — kontrolerių kanalai Draudžiami.

## Neįtraukta
- Bucket perėjimų darymas pagrindiniame medyje dispatch'o metu (worktree izoliacijos dizainas) — atskira, rizikingesnė kryptis.
- `WavesPanel` (#/system) praturtinimas — ten gyvi slot'ai jau rodomi.
- SSE `/api/events` ir bet koks serverio pusės pakeitimas.
