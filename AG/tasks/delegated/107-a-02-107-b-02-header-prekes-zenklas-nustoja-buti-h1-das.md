## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 107-marsruto-pavadinimas-tampa-vieninteliu-h1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `Header.tsx` 58 eil. „VERQESTRA" nebėra `<h1>`, o `DashboardPage.tsx` page-heading
(dabar 153 eil., `pageMeta(activeRoute).title`) yra `<h1>` — ALREADY_IMPLEMENTED:
cituok abiejų vietų JSX kaip įrodymą.

## Tikslas
UI audito P2 (docs/audits/ui-app-2026-08-31/report.md, „Puslapio pavadinimas nėra
pagrindinis H1"): vienintelis `h1` visuose ekranuose yra prekės ženklas, o aktyvaus
maršruto pavadinimas — `h2`. Šis darbas uždaro pagrindinius maršrutus: prekės ženklas
tampa neutraliu elementu, `DashboardPage` puslapio pavadinimas — vieninteliu `h1`.
CSS jau paruoštas ankstesniame darbe (`.brand .brand-title`, `.page-heading h1`).

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `ui-app/src/view/components/Header.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/accessibility.test.tsx`
- `ui-app/src/view/styles/dashboard.css` (paruoštas 107-marsruto-pavadinimas-tampa-vieninteliu-h1; tikėtina, kad naujų taisyklių čia nereikės)
- `ui-app/src/i18n/I18nContext.tsx` (tikėtina, kad naujo teksto nereikės: elementas lieka be aria-label)

Draudžiama:
- `ui-app/src/view/pages/BenchmarkPage.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `Header.tsx:58`: `<h1>VERQESTRA</h1>` → `<span className="brand-title">VERQESTRA</span>`
  (jokių naujų tekstų, jokio aria-label).
- `DashboardPage.tsx:153` page-heading pavadinimo elementą iš `h2` į `h1`.
- `accessibility.test.tsx`: pridėk lūkestį, kad pagrindiniuose maršrutuose DOM turi
  lygiai vieną `h1` ir jo tekstas yra maršruto pavadinimas, ne „VERQESTRA".

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Jei `accessibility.test.tsx` jau tikrina antraščių
lygius senu būdu — atnaujink skaičių, bet NIEKADA nesilpnink asserto. Jei paaiškėja, kad
prekės ženklui vis dėlto reikia i18n teksto — sustok ir pranešk, nekeisk `I18nContext.tsx`.

## Neįtraukta
- `BenchmarkPage`, `CompressionPage`, `ReliabilityPage`, `TokenUsagePage` antraštės — sekantys darbai.
- Panelių `panel-header h2` hierarchija.
- `page-eyebrow` / aprašymo tekstai.
