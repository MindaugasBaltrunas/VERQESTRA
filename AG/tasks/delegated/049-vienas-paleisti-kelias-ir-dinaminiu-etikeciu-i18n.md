## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei header'io ir `#/system` „Paleisti" mygtukai kviečia TĄ PATĮ endpoint'ą (arba
turi aiškiai skirtingas etiketes, paaiškinančias skirtumą), o dinaminės būsenos
(`Starting...`, `Error: ...`) bei klaidų žinutės verčiamos per `t()` abiem
kalbom — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-27 UI auditas: (a) du vienodai atrodantys „Paleisti" — header'io
(`Header.tsx:102-106` → `POST /tasks/resume`) ir sekcijos „Paleisti ciklą (N
srautų)" (`LoopControls.tsx:142-150` → `POST /api/runtime/loop/start`, kuris
papildomai resetina srautų valdiklį) — daro skirtingus dalykus be jokio ženklo.
(b) Dinaminės etiketės `▶ Starting...`, `▶ started (pid ...)`, `⏹ stopping`,
`▶ Error: ...` (`useDashboardController.ts:38-41,239,248,268,277`) neturi
žodyno įrašų (`I18nContext.tsx:437-438` turi tik Start/Stop) — LT sąsajoje lieka
angliškos. (c) Klaidų literalai sumaišyti: LT (`:187,294,309`) ir EN (`:249`).

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/controller/useDashboardController.ts`
- `ui-app/src/view/components/Header.tsx`
- `ui-app/src/view/components/LoopControls.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/tests/**`

Draudžiama:
- `src/**`
- `ui-app/src/api.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect sprendimas: header'io mygtuką nukreipti į `/api/runtime/loop/start`
  su esamu `workers` pasirinkimu ARBA palikti `/tasks/resume`, bet etiketę
  pakeisti į „Tęsti ciklą" (resume semantika) — vienas iš dviejų, dokumentuota.
- Dinamines būsenas modeliuoti raktu + parametrais (`{state:"starting"}`), o ne
  gatavu stringu; `t()` žodyne — LT/EN įrašai visoms būsenoms.
- Visus klaidų literalus kontroleryje perkelti į žodyną (viena kalba šaltinyje).
- Testai: LT režime nelieka angliškų būsenų etikečių.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei prireiktų keisti serverio
endpoint'us.

## Neįtraukta
Skaičių formatas pagal locale (053). run() kelio suvienodinimas (048).
