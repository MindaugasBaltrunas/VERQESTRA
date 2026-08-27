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
- `AG/openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/spec.md` („Nauji UI (ui-app) vertimai reason reikšmėms“)
- `src/interfaces/http/ui-compression-view.ts` — `UiCompressionRecommendation.reason` sąjunga (jau turi larger-on-average / smaller-under-pressure / smaller-no-pressure / too-few-comparisons)

## Tikslas
`CompressionPage` rodo suprantamą, išverstą tekstą kiekvienai iš keturių NAUJŲ (ne worker_task_ir) `reason` reikšmių — nė viena vėliava neekrane nelieka su neišverstu raw kodu (pvz. "larger-on-average").

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> coder -> i18n -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/CompressionPage.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/pages/CompressionPage.test.tsx`

Draudžiama:
- `AG/**`
- `vq/**`
- `.env`
- `src/**`

## Veiksmas
- `CompressionPage.tsx` faile `REASON_SENTENCES` žemėlapyje pridėti 4 trūkstamus raktus: `larger-on-average`, `smaller-under-pressure`, `smaller-no-pressure`, `too-few-comparisons` (angliškos formuluotės analogiškos jau esantiems `ir-*` variantams, bet be IR konteksto).
- `ui-app/src/i18n/I18nContext.tsx` `lt` žodyne pridėti lietuviškus vertimus tiems patiems 4 naujiems angliškiems sakiniams (tikslus tekstas iš CompressionPage.tsx REASON_SENTENCES).
- `CompressionPage.test.tsx` papildyti testu, kuris renderina rekomendaciją su viena iš keturių naujų `reason` reikšmių (pvz. `compact_dsl` su `smaller-under-pressure`) ir tikrina, kad ekrane rodomas išverstas sakinys, ne raw kodas.

## Patikra
- `pnpm --dir ui-app test`
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai visos trys patikros žalios. Sustok ir raportuok, jei paaiškėtų, kad `REASON_SENTENCES` ar `lt` žodyno struktūra pasikeitusi kitaip, nei aprašyta čia — nesikurk naujos struktūros savavališkai. Naujo CSS `className` šiam darbui nereikia; jei prireiktų, sustok ir raportuok.

## Neįtraukta
- Matavimų rašytojai ir `decideCompression` logika (jau atlikta ankstesniame darbe).
- Vėliavų įjungimas ir benchmark kohortos.
