# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `mobile-app/src/model/reducer.ts` `ag-loop.tasks` sėkmės šaka (dabar
98-103 eil.) atnaujina ir link/error būseną (arba link/error laikomi
per-kanalo laukais), o dashboard sėkmė (dabar 96 eil.) nebevalo bucket
kanalo klaidos besąlygiškai — ALREADY_IMPLEMENTED: cituok reducer šakas ir
jų testus kaip įrodymą.

## Tikslas
Mobile audito P1 (2026-09-01): du susiję `reducer.ts` būsenos defektai —
tas pats failas ir mechanizmas, todėl VIENAS task'as. Patikrinta
`mobile-app/src/model/reducer.ts`:

1. `ag-loop.tasks` sėkmė (98-103 eil.) keičia TIK `agLoopTaskBucket`;
`agLoopLink` ir `agLoopReadError` liečiami tik `ag-loop.dashboard` šakoje
(88-97 eil.). Pasekmė: jei dashboard skaitymas krito, o bucket skaitymas
teka, klaida ir „connecting"/„degraded" link'as lieka amžinai —
`ag-loop-presenter.ts:110` `showLoadingPlaceholder` (dashboard null +
connecting) rodo amžiną spinnerį, nors bucket duomenys sėkmingai ateina.

2. `agLoopReadError` yra BENDRAS abiem kanalams (`ag-loop.read-failed`,
113-124 eil., nešakoja pagal kanalą), o dashboard sėkmė jį valo BESĄLYGIŠKAI
(96 eil. `agLoopReadError: null`). Pasekmė: bucket'ui kritus ir dashboard'ui
pavykus, `stale` (`ag-loop-presenter.ts:92` — `agLoopDashboard !== null &&
agLoopReadError !== null`) tampa false — cache'uotos bucket eilutės rodomos
kaip patvirtintos šviežios.

Kryptis: per-kanalo link/error būsena (dashboard ir tasks kanalai settle'ina
savo klaidas atskirai) ARBA simetriškas settle — `ag-loop.tasks` sėkmė
atnaujina link'ą ir valo TIK savo kanalo klaidą. Formą pasirenka vykdytojas;
kriterijus vienas: nė vieno kanalo sėkmė negali nei palikti svetimos amžinos
klaidos, nei nuslėpti svetimos gyvos klaidos.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `mobile-app/src/model/reducer.ts`
- `mobile-app/src/model/state.ts` (`AppState` tipas — reducer.ts:6 importas;
  liečiamas tik jei per-kanalo formai reikia naujų laukų)
- `mobile-app/src/controller/presentation/ag-loop-presenter.ts` (tik jei
  per-kanalo forma keičia skaitomus laukus — `stale`/`showLoadingPlaceholder`
  semantika lieka ta pati)
- `mobile-app/src/tests/ag-loop-read-model.test.ts`
- `mobile-app/src/tests/ag-loop-presentation.test.ts`
- `mobile-app/src/tests/screen-degraded-ag-loop.test.ts` (jei degraded
  scenarijų assert'ai liečia bendrus laukus)

Draudžiama:
- `mobile-app/src/controller/**` (skaitymo kontroleriai teisingi — problema
  reducer'io settle logikoje; išimtis — Leidžiama įvardytas presenter'is)
- `mobile-app/native/**` (118-121 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `reducer.ts`: įgyvendinti pasirinktą formą; esamos invariantų taisyklės
  LIEKA — bucket intent apsauga (99-102 eil.), `read-settled` ne žemiau
  nulio (82-87), availability „tik išlaikyti ar žeminti" (114-118).
- Testų lūkestis (regresijos abiem defektams): (1) dashboard kritęs + bucket
  sėkmė → spinneris dingsta, bucket klaidos nebėra, dashboard klaida (jei
  rodoma) atskiriama; (2) bucket kritęs + dashboard sėkmė → bucket eilutės
  žymimos stale (dashboard sėkmė NEnuvalo bucket klaidos); (3) abu kanalai
  sėkmingi → jokios klaidos, ne-stale; (4) esami reducer testai lieka žali
  be silpninimo.
- PATIKROS PASTABA: vykdytojas PRIVALO papildomai paleisti
  `pnpm test:mobile-app` (šakninis script'as; `pnpm --dir ...` blokuoja bash
  hook'ai) ir rezultatą įrašyti į ataskaitą — `## Patikra` vartas mobile
  formų neleidžia.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros ir `pnpm test:mobile-app` žali. Stop ir klausk, jei
per-kanalo forma pareikalautų keisti `AppEvent` kontraktą taip, kad lūžtų
gateway pusės event gamintojai — tai kirstų paketo ribą.

## Neįtraukta
- `ag-loop-presenter.ts` pateikimo taisyklių keitimai (stale apibrėžimas 89-92
  eil. komentare teisingas — taisoma jo maitinimo būsena).
- Native ekranų pakeitimai — reducer platform-neutralus.
- Gateway skaitymo kanalo elgesys — įvykius gamina teisingai.
