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
openspec/changes/verqestra-backlog-v1 (`AG/openspec/changes/verqestra-backlog-v1/tasks.md`)

## Tikslas
`captureBenchmarkReport` nepriskirtų (unassigned) task'ų usage tyliai neįtraukia į `totals`, o `integrity.ok` nuo to nepriklauso. Padaryti unassigned usage matomą `BenchmarkIntegrity` struktūroje ir markdown ataskaitoje, kad darbo perkėlimas į frozen šablonų neatitinkančius task'us nebegalėtų „pagerinti" metrikos be pėdsako. Prieš keisdamas kodą patikrink, ar `integrity.ok` jau priklauso nuo unassigned usage esamame kode — jei taip, nieko nekeisk ir galutinę ataskaitą pradėk eilute `ALREADY_IMPLEMENTED: <failai/eilutės-įrodymas>`.

## Agentai
Privaloma grandinė: `readme-guard -> coder -> reviewer -> tester`. readme-guard pirmas, be jo README ribų santraukos kodo nekeisti.

## Failai
Leidžiama:
- `src/application/benchmark/capture-baseline.ts`
- `src/application/benchmark/baseline-report.ts`
- `src/tests/**`

Draudžiama:
- `src/domain/metrics/comparison.ts`
- `src/application/benchmark/baseline-comparison.ts`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- `capture-baseline.ts`: į `BenchmarkIntegrity` pridėti `unassigned_usage_records` ir `unassigned_total_tokens` (skaičiuojant iš `usageByTask` prieš `continue`), ir sugriežtinti `ok` taip, kad unassigned task'as su usage > 0 duotų `ok: false`.
- `baseline-report.ts`: naujus laukus atspausdinti integrity sekcijoje; parse turi likti suderinamas atgal — senas markdown be šių laukų toliau parsinamas su default 0, o `parseBenchmarkReportMarkdown(render(x)) == x` naujiems laukams.
- `src/tests/**`: pridėti case'us — unassigned task su usage>0 duoda `ok=false` ir nenulinius naujus laukus; unassigned be usage nelaužo `ok`; round-trip su naujais laukais; senas markdown be jų perskaitomas su default 0.

## Patikra
Po bet kurio `src` pakeitimo pirmiausia perbuild'ink tiksliai šia forma (be pipe/redirect), kitaip `dist` pasensta ir hook'ai blokuoja: `pnpm build`. Tada patikroms naudok tik:
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink IŠ KARTO, kai tik abi patikros žalios ir failai ≤500 eilučių — nepalik necommit'into darbo sesijos pabaigai. Sustok po commit'o — comparability priežasties (`compareBenchmarkRuns`) šioje dalyje neliesti.

## Neįtraukta
- `token_basis` (raw vs billable) keitimas.
- Frozen konfigo `cases` keitimas.
- Queue loop vykdymas.
