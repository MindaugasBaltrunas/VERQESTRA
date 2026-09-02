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
- 108-uzduociu-lentos-stulpeliai-lt-rezime-verciami

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/view/components/MoreMenu.tsx` ekranų sąrašas (dabar viena
`Screens` sekcija, 61-74 eil.) suskirstytas į 2-3 įvardytas sekcijas, o tema
ir kalba pateikiamos kaip kompaktiška nustatymų eilutė —
ALREADY_IMPLEMENTED: cituok sekcijų antraštes ir nustatymų eilutės JSX kaip
įrodymą.

## Tikslas
UI audito P3 (docs/audits/ui-app-2026-08-31/report.md, „Mobilus meniu turi
antrą slinkimo zoną"): 390 × 844 ekrane meniu turinys — 757 px, matoma dalis
— 589 px; temos, kalbos ir dalis įrankių lieka žemiau pirmo vaizdo, nes 10
ekranų ir visi įrankiai sudėti į vieną sąrašą. Patikrinta 2026-09-01:
`ui-app/src/view/components/MoreMenu.tsx` — viena `Screens` sekcija su visais
`ROUTE_LABELS` maršrutais (61-74 eil.) ir `Tools` sekcija su ciklo veiksmais,
atnaujinimu, tema ir kalba (76+ eil.); komponento antraštės komentaras
(6-18 eil.) fiksuoja dizaino sprendimą „pilnas sąrašas vienoje vietoje" —
jis lieka galioti, keičiasi tik vidinis organizavimas. Sprendimas pagal
report: dažniausius ekranus palikti viršuje, retesnius sugrupuoti į 2-3
sekcijas, o temą ir kalbą sutraukti į vieną kompaktišką nustatymų eilutę —
kad pirmame vaizde tilptų daugiau ir slinkimo zona sutrumpėtų. `ROUTE_LABELS`
lieka VIENINTELIS maršrutų vardų šaltinis (Header.tsx:74-76 komentaro
taisyklė) — grupavimas jo nedubliuoja, tik skirsto.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/MoreMenu.tsx`
- `ui-app/src/view/components/MoreMenu.test.tsx` (numatomas naujas — testo
  failo komponentas šiandien neturi; jei dengimas natūraliau gula esamame
  App.test.tsx — tas failas vietoje šio, įrašyti į ataskaitą)
- `ui-app/src/i18n/I18nContext.tsx` (sekcijų antraščių raktai)
- `ui-app/src/view/styles/dashboard.css` (sekcijų ir nustatymų eilutės
  klasės)

Draudžiama:
- `ui-app/src/view/components/Header.tsx` (107 scope; meniu vidus gyvena
  MoreMenu — Header tik jį įdeda)
- `ui-app/src/controller/useRoute.ts` (`ROUTE_LABELS` sąrašas ir tvarka —
  bendras šaltinis su nav juosta, nekeičiamas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `MoreMenu.tsx`: ekranų sąrašą suskirstyti į 2-3 sekcijas su verčiamomis
  antraštėmis (pvz. pagrindiniai / analitika / sistema — grupavimą
  pasirenka vykdytojas ir pagrindžia ataskaitoje); temą ir kalbą pateikti
  viena kompaktiška nustatymų eilute vietoje atskirų pilno pločio mygtukų.
  Ciklo veiksmų dubliavimas meniu viduje LIEKA (77-78 eil. komentaras —
  „Sustabdyti ciklą" negali tapti nepasiekiamas).
- Prieinamumas išlaikomas: `<details>`/`summary` mechanika, `aria-current`,
  uždarymas Escape ir paspaudimu šalia — esamas elgesys nekeičiamas.
- Testų lūkestis: (1) visi `ROUTE_LABELS` maršrutai meniu tebėra pasiekiami
  (nė vienas ekranas nedingo grupuojant); (2) aktyvus maršrutas žymimas
  `aria-current`; (3) tema ir kalba perjungiamos iš nustatymų eilutės.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
- Nav juostos (`Header.tsx` skirtukų) keitimai — auditas gyrė jos elgesį.
- Maršrutų sąrašo trumpinimas ar slėpimas — visi 10 ekranų lieka meniu.
- Slinkimo zonos aukščio matavimo automatinis testas — jsdom aukščių
  nematuoja patikimai; struktūrinis grupavimas yra pataisos esmė.
