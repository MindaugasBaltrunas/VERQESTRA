# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
P2 (2026-08-25 optimizavimo auditas): `captureBenchmarkReport`
(`src/application/benchmark/capture-baseline.ts`) nepriskirtų (unassigned) task'ų
usage tyliai neįtraukia į `totals`, o `integrity.ok` nuo to nepriklauso
(`ok: malformed === 0 && ambiguous.length === 0`). Optimizacija, perkelianti darbą į
frozen šablonų neatitinkančius task'us, „pagerintų" metriką be jokio signalo.
Kryptis griežtinanti: unassigned task'ai su usage > 0 turi būti matomi palyginimo
verdikte — arba per `integrity.ok=false`, arba per atskirą skaitiklį, kurį
`compareBenchmarkRuns` traktuoja kaip comparability priežastį, kai baseline/current
unassigned aibės skiriasi.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/benchmark/capture-baseline.ts`
- `src/application/benchmark/baseline-comparison.ts`
- `src/application/benchmark/baseline-report.ts`
- `src/domain/metrics/comparison.ts`
- `src/tests/**`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- Į `BenchmarkIntegrity` įtraukti unassigned task'ų usage matomumą (pvz. `unassigned_usage_records` arba tokenų suma) ir apsispręsti dėl `integrity.ok` griežtinimo — pasirinkimą pagrįsti ataskaitoje.
- `compareBenchmarkRuns` arba `compareWithBaseline` lygyje užtikrinti, kad besiskirianti unassigned aibė su realiu usage negalėtų likti be pėdsako verdikto priežastyse.
- Išlaikyti round-trip: `parseBenchmarkReportMarkdown(render(x)) == x` su naujais laukais.
- Testai: task'as be case atitikmens su usage > 0 matomas integrity/verdikto priežastyse; senas baseline be naujų laukų toliau perskaitomas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir unassigned usage nebegali dingti be pėdsako.

## Neįtraukta
- `token_basis` (raw vs billable) keitimas — atskiras operatoriaus sprendimas.
- Frozen konfigo `cases` keitimas.
- Queue loop vykdymas.
