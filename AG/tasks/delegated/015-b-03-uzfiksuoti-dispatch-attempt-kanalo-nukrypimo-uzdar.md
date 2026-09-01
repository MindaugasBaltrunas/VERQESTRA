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
openspec/changes/verqestra-backlog-v1/ (tasks.md eilutė: dispatch flow matavimas)

## Tikslas
Uždaryti `migration-coverage.json` įrašą apie dispatch attempt kanalo nukrypimą nuo etalono: attempt rezoliucija įvielinta, tad nukrypimas nebegalioja. CLAUDE.md reikalauja, kad nukrypimas ir jo uždarymas būtų fiksuojamas su priežastimi, o ne tyliai.

## Agentai
PRIVALOMA grandinė šia tvarka: readme-guard -> documenter -> reviewer. readme-guard eina pirmas ir grąžina ribų santrauką.

## Failai
Leidžiama:
- `migration-coverage.json`

Draudžiama:
- `src/**`
- `.env`
- `.env.*`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Surasti `migration-coverage.json` įrašą apie neįvielintą dispatch attempt kanalą (2026-08-25) ir pažymėti jį uždarytu su data bei priežastimi.
- Neliesti jokio kito įrašo ir nepridėti naujų nukrypimų.

## Patikra
- `pnpm test`

## Stop
Sustoti, kai `pnpm test` praeina. Tada commitinti ir sustoti. Sustoti nedelsiant, jei įrašo nerandama arba jo formatas neaiškus — tokiu atveju pranešti, o ne spėti.

## Neįtraukta
- Bet koks produkcinio kodo keitimas.
- Task 016 ir 017 darbai.
