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
openspec/changes/verqestra-backlog-v1/

## Tikslas
Audituoti dashboard punktą 7: reviews/policy formoje nėra „Available values"/„Recommended" komentarų, `SelectMenu` turi teisingą ARIA, ir NĖRA „Change reason (required)" lauko. Punktą pažymėti ✅/❌ su `failas:eilutė` įrodymu. Priklauso nuo 069-a.

## Agentai
PRIVALOMA grandinė: readme-guard -> reviewer -> coder -> tester. readme-guard pirmas.

## Failai
Leidžiama:
- `ui-app/src/view/components/PolicyControlsPanel.tsx`
- `ui-app/src/view/components/PolicyControlsPanel.test.tsx`
- `ui-app/src/view/components/SelectMenu.tsx`
- `ui-app/src/view/components/SelectMenu.test.tsx`
- `ui-app/src/view/pages/CompressionPage.tsx`
- `ui-app/src/view/pages/CompressionPage.test.tsx`
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/i18n/I18nContext.tsx`

Draudžiama:
- `ui-app/src/model/**`
- `ui-app/src/controller/**`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Grep `Available values`, `Recommended`, `required` per leidžiamus failus; kiekvieną likutį įvertinti ir pašalinti, jei tai senos formos liekana.
- Read `SelectMenu.tsx`: patvirtinti `role`, `aria-expanded`, `aria-activedescendant` ir klaviatūros navigaciją; trūkstamus ARIA atributus pridėti.
- Ataskaitoje pažymėti punktą 7 su `failas:eilutė`; trūkstamą i18n raktą ar CSS taisyklę TIK įrašyti, NETAISYTI.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios ir punktas 7 pažymėtas su įrodymais. Sustok, jei pašalinus lauką lūžtų formos kontraktas su controller sluoksniu — tada ataskaita, ne pataisa.

## Neįtraukta
CSS ir i18n pataisymai (069-a). SystemStatusHero ir RuntimePanel (069-b). WavesPanel, LoopControls (069-c). Slotai ir sprendimų eilė (069-e). Galutinis build (069-f). Serverio kodas, mobile.
