## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Benchmark raporto modelis (`AG/benchmark`) turi nešti nematuotų celių pjūvį per režimą: bandyta / išmatuota / atmesta + atmetimo priežasčių santrauka. Šiandien `BenchmarkRunSummary.unmeasured` egzistuoja, bet raporto modelis jo nepaima, tad 2026-08-26 bėgimas rodo „48 samples" vietoj „48 iš 72, 24 atmestos".

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester. readme-guard eina pirmas ir grąžina ribų santrauką.

## Failai
Leidžiama:
- `AG/benchmark/src/application/report/benchmark-report-model.ts`
- `AG/benchmark/src/application/report/benchmark-report.ts`
- `AG/benchmark/src/application/report/benchmark-report-json.ts`
- `AG/benchmark/src/application/report/benchmark-report-markdown.ts`
- `AG/benchmark/src/tests/benchmark-report.test.ts`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`
- `src/**`
- `ui-app/**`

## Veiksmas
- Į raporto modelį pridėti adityvų per-režimo pjūvį: `attemptedCount`, `refusedCount` ir atmetimo priežasčių santrauka (unikalios `reason` reikšmės su skaičiais, ne pilnas įrašų sąrašas), maitinamą iš `BenchmarkRunSummary.unmeasured`. `sampleCount` prasmė NEKEIČIAMA — jis lieka „išmatuotos".
- JSON ir markdown renderiuose režimo sekcijoje rodyti `Samples: measured N of M attempted (K refused)`, o priežasčių santrauką — atskira eilute arba limitations skiltyje.
- Atgalinis suderinamumas: senas raportas be naujų laukų skaitomas toliau (default 0 / absent), kaip 018 padaryta `parseBenchmarkReportMarkdown` pusėje.

## Patikra
- `pnpm --dir AG/benchmark test`
- `pnpm build`

## Stop
Commit'ink iš karto, kai abi patikros žalios. Sustok nedelsiant, jei pakeitimas reikalautų keisti užantspauduotų baseline dokumentų schemą arba `sampleCount` prasmę.

## Neįtraukta
- `src/application/benchmark/suite-report-view.ts` zod schema (kitas darbas).
- `src/composition/ui/analytics-adapters.ts` wiring (kitas darbas).
- `ui-app` tipai ir BenchmarkPage (kitas darbas).
- Atmestų celių priežasčių taisymas (task 023), pakartotinis mokamas bėgimas, LLM kvietimai.
