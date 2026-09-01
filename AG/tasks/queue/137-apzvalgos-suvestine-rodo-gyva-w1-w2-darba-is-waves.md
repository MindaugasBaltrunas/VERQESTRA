# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 110-lt-datos-laukai-neberodo-dvieju-priestaraujanciu-formatu

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/view/pages/DashboardPage.tsx` `QueueSnapshot` (dabar 375-389
eil.) arba gretimas apžvalgos blokas rodo in-flight eilutę iš waves duomenų
(gyvi `UiWaveSlot`/`UiWaveLease` su worker ir task id) — ALREADY_IMPLEMENTED:
cituok JSX, duomenų pravedimą ir testą kaip įrodymą.

## Tikslas
Gyvas 2026-09-01 operatoriaus klausimas: apžvalgos „Workflow snapshot" NERODO,
kad w1/w2 dirba. Patikrinta: `DashboardPage.tsx:375-389` `QueueSnapshot`
rodo TIK pagrindinio medžio bucket'ų skaičius (`buckets` iš dashboard API,
385 eil.), o worktree izoliacijoje dispatchinto task'o `queue→active/
delegated` perėjimas vyksta tik worktree KOPIJOJE — pagrindiniame medyje
failas visą dispatch'ą guli `queue`, tad `active`/`delegated` skaitliukai
amžinai 0. TEISINGI gyvi duomenys jau atkeliauja į TĄ PATĮ komponentą:
`DashboardPage.tsx:64-68` overview route jau vartoja `useWavesController`
(vienintelis 30 s polling'as — 64-66 eil. komentaro taisyklė), o klientinis
tipas `UiWaveSlot` (`model/types.ts:797-810`) neša `worker_id`, `task_id`,
`state` (`"running"`), `stale`; `UiWaveLease` (775-781) — atsarginis kelias
senam serveriui be `slots` (846-847 eil. optional pastaba). Sprendimas:
suvestinė papildoma in-flight eilute(-ėmis) — pvz. „Vykdoma dabar: w1 →
<task>, w2 → <task>" — maitinama iš JAU turimų waves duomenų, perduodant
juos į `QueueSnapshot` (ar gretimą bloką) be jokio naujo fetch kanalo;
grynas išvedimas (kurie slot'ai rodomi: `running` ir ne-`stale`; lease
fallback be `slots`) — model funkcija su unit testais.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/model/dashboardViewModel.ts` (grynas in-flight išvedimas iš
  waves duomenų; jei natūralesnė vieta — atskiras naujas model failas, tas
  vietoje šio, įrašyti į ataskaitą)
- `ui-app/src/model/dashboardViewModel.test.ts`
- `ui-app/src/dashboardSmoke.test.tsx` (apžvalgos renderio dengimas; jei
  QueueSnapshot dengiamas kitame esamame teste — tas failas vietoje šio,
  įrašyti į ataskaitą)
- `ui-app/src/i18n/I18nContext.tsx` (nauji tekstai: „Vykdoma dabar" ir kt.)
- `ui-app/src/view/styles/dashboard.css` (in-flight eilutės klasės — CSS
  dengiamumo vartas)

Draudžiama:
- `ui-app/src/controller/useWavesController.ts` ir `ui-app/src/model/api.ts`
  (duomenų kanalas jau teisingas — jokio naujo polling'o ar endpoint'o)
- `ui-app/src/view/components/WavesPanel.tsx` (#/system vaizdas nekinta)
- `src/**` (serverio pusė neliečiama — visi laukai jau serve'inami per
  /api/waves)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Model: gryna funkcija, iš `UiWavesView` išvedanti in-flight sąrašą —
  pirmenybė `slots` (`state === "running"`, `stale === false`), fallback
  per `leases` kai `slots` nėra (senas serveris); tuščias rezultatas =
  eilutė nerodoma (jokio „0 vykdoma" triukšmo).
- `DashboardPage.tsx`: `waves` duomenys (jau turimi 68 eil.) perduodami į
  `QueueSnapshot` (ar gretimą apžvalgos bloką); in-flight eilutė rodo
  worker → task poras; waves klaida ar `null` (dar neatsikrovė) — suvestinė
  atrodo kaip iki šiol, be klaidos triukšmo šiame bloke (klaidų kanalą jau
  turi kiti vartotojai).
- i18n: nauji raktai su EN sentinelėmis ir LT vertimais; task id NEVERČIAMI
  (identifikatoriai).
- Testų lūkestis: (1) model — slots atranka (running/ne-stale), lease
  fallback, tuščias atvejis; (2) render — su gyvu w1/w2 slot'u suvestinėje
  matomos worker→task eilutės, be jų — esamas vaizdas nepakitęs; (3) esami
  QueueSnapshot/bucket testai žali.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad waves
duomenys apžvalgos route'e nepasiekiami be `useDashboardController`/
`useWavesController` kontraktų keitimo — kontrolerių kanalai šio task'o
Draudžiami.

## Neįtraukta
- Bucket perėjimų darymas pagrindiniame medyje dispatch'o metu (kad `active`
  skaitliukai judėtų) — atskira, rizikingesnė kryptis, liečianti worktree
  izoliacijos dizainą; sąmoningai nesirenkama čia.
- `WavesPanel` (#/system) praturtinimas — ten gyvi slot'ai jau rodomi.
- SSE/`/api/events` kanalo naudojimas šiai eilutei — waves polling'o
  pakanka suvestinei, o antro kanalo derinimas būtų naujas sudėtingumas.
- Pagrindinio medžio bucket skaitliukų semantikos keitimas — jie rodo tai,
  ką rodo (failų vietą), in-flight eilutė papildo, ne pakeičia.
