# Task

## Spec source
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „Nauji UI (`ui-app`) vertimai `reason` reikšmėms“)
- `src/interfaces/http/ui-compression-view.ts` — `UiCompressionAction` ir `reason` sąjungos (išplėstos ankstesniame darbe)

## Tikslas
Kompresijos puslapis rodo suprantamą tekstą kiekvienai naujai `action`/`reason` kombinacijai — nė viena vėliava nelieka su neišverstu raktu ekrane.

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> coder -> i18n -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/panels/CompressionPanel.tsx`
- `ui-app/src/i18n/lt.ts`
- `ui-app/src/styles/dashboard.css`
- `ui-app/src/panels/CompressionPanel.test.tsx`

Draudžiama:
- `AG/**`
- `vq/**`
- `.env`
- `src/**`

## Veiksmas
- Pridėti vertimus visoms naujoms `reason` reikšmėms ir vėliavos/veiksmo kombinacijoms; jokio teksto tiesiai TSX'e, viskas per i18n žodyną.
- Kiekviena nauja `className` privalo turėti taisyklę `dashboard.css` (vartas `dashboard-css-coverage.test.ts`) — jokio inline stiliaus vietoje taisyklės.
- Jei tikslūs `ui-app` failų keliai skiriasi nuo nurodytų `## Failai`, sustoti ir raportuoti faktinius kelius, o ne plėsti scope savarankiškai.

## Patikra
- `pnpm --dir ui-app test`
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai visos trys patikros žalios. Sustok, jei vertimams prireiktų keisti `src/interfaces/http/ui-compression-view.ts` kontraktą — tai ankstesnio darbo riba.

## Neįtraukta
- Matavimų rašytojai ir `decideCompression` logika.
- Vėliavų įjungimas ir benchmark kohortos.
