# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Pertvarkyti `PolicyControlsPanel` korteles taip, kad reikšmė būtų renkama TIK per `SelectMenu` dropdown be aiškinamųjų komentarų aplink, o išdėstymas būtų lygiuotas ir profesionalus (pavadinimas → dabartinė reikšmė → nauja reikšmė → veiksmai), be inline `style` atributų.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/PolicyControlsPanel.tsx`
- `ui-app/src/view/components/PolicyControlsPanel.test.tsx`
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/i18n/I18nContext.tsx`

Draudžiama:
- `ui-app/src/view/components/SelectMenu.tsx`
- `ui-app/src/App.tsx`
- `ui-app/src/view/components/HumanReviewPanel.tsx`
- `ui-app/src/controller/`
- `ui-app/src/model/api.ts`
- `src/`
- `dist/`
- `node_modules/`

## Veiksmas
- Pašalinti tris komentarų šaltinius: „Available values" kodų juosteles, abu `small` aiškinamuosius sakinius prie „Recommended" ir `HelpPopover` („?") formoje, kartu su `CODING_PRINCIPLES_HELP` konstanta, jei nebelieka skaitytojų. `policy-value-guide` trijų stulpelių bloką pakeisti kompaktiška „Current → New" eilute; inline `style={{...}}` perkelti į CSS klases.
- Formos `<select>` pakeisti į `SelectMenu` (importuojamą, nekeičiamą); boolean nustatymai — irgi per `SelectMenu` su true/false variantais, siunčiant tikrą boolean; skaitiniai nustatymai be `allowed_values` lieka su `input`. Rekomenduojamą reikšmę žymėti `SelectMenu` varianto `tag` ženkleliu, o ne sakiniu kortelėje. „Change reason" laukas lieka.
- Visoms naujoms className pridėti taisykles `dashboard.css` (`dashboard-css-coverage.test.ts` vartas), naujus tekstus — per `t(...)` ir `I18nContext.tsx`; atnaujinti `PolicyControlsPanel.test.tsx`: komentarų blokų nebėra, dropdown atiduoda pasirinktą reikšmę į `onPropose`, boolean nustatymas siunčia tikrą boolean.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei `SelectMenu` reikėtų keisti, jei reikėtų silpninti testą/guard'ą arba liesti draudžiamus failus.

## Neįtraukta
`PolicyProposalsPanel` (`App.tsx`) ir `CompressionPage` `<select>` migracija į `SelectMenu`; `HumanReviewPanel` veiksmų mygtukai lieka mygtukais; „Change reason" lauko šalinimas (public kontraktas, reikia atskiro operatoriaus sprendimo).
