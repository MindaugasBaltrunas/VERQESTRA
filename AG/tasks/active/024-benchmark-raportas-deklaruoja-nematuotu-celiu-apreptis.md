# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/020-session-writes-ledger-diagnosis-2026-08-25.md (giminingas „nematuota ≠ nepavykusi" principas)

## Tikslas
Benchmark raportas (JSON + markdown + UI) privalo DEKLARUOTI nematuotas celes: 2026-08-26
pilname bėgime ag-loop turėjo 72 bandytas / 48 išmatuotas / 24 atmestas celes, o raportas rodo
tik „48 samples" — skaitytojas negali atskirti „visa aprėptis" nuo „trečdalis prarasta".
„No silent caps" taisyklė: apribota aprėptis skelbiama, ne nutylima.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `AG/benchmark/src/**`
- `src/application/benchmark/suite-report-view.ts`
- `src/composition/ui/analytics-adapters.ts`
- `ui-app/src/model/types.ts`
- `ui-app/src/view/pages/BenchmarkPage.tsx`
- `src/tests/**`
- `ui-app/src/**/*.test.*`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI: `results/runs/run-20260825t210704416z.unmeasured.jsonl` — 24 įrašai (8 scenarijai × 3
  rep., visi ag-loop, `sample-refused: telemetry.attempts out-of-range: received 0`).
  `BenchmarkRunSummary` tipas `unmeasured` (UnmeasuredCell) žino; raporto modelis
  (`application/report/benchmark-report-model.ts`) jo NENEŠA, tad nei markdown, nei JSON, nei
  UI negali parodyti.
- Raporto modelin pridėti nematuotų celių pjūvį PER REŽIMĄ: bandyta / išmatuota / atmesta +
  atmetimo priežasčių santrauka (unikalios `reason` reikšmės su skaičiais, ne pilnas sąrašas).
- JSON ir markdown renderiai: režimo sekcijoje „Samples: measured N of M attempted (K refused)";
  atmetimų priežastys — limitations arba atskira eilutė sekcijoje.
- Wire grandinė: `suite-report-view` schema (zod) + `ui-app/src/model/types.ts` + BenchmarkPage
  režimo tab'e ta pati eilutė. Kontraktas pin'inamas iš ABIEJŲ pusių (repo pamoka: `as` per
  HTTP ribą nėra kontraktas — žr. `composition-ui-dashboard-contract.test.ts` šabloną).
- Atgalinis suderinamumas: senas raportas be naujų laukų skaitomas toliau (default 0 / absent),
  kaip 018 padaryta `parseBenchmarkReportMarkdown` pusėje.
- SVARBU dėl formos: laukai adityvūs — `sampleCount` semantika NEKEIČIAMA (jis lieka
  „išmatuotos"), kad nesulūžtų baseline'ų palyginamumas.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir AG/benchmark test`
- `pnpm --dir ui-app test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok nedelsiant, jei pakeitimas reikalautų keisti
jau užantspauduotų baseline dokumentų schemą arba `sampleCount` prasmę.

## Neįtraukta
- Atmestų celių PRIEŽASČIŲ taisymas (task 023 — approval žyma celėms).
- Pakartotinis mokamas bėgimas.
- LLM kvietimai, queue loop vykdymas.
