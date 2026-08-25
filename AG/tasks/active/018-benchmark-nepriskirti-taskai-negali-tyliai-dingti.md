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
`captureBenchmarkReport` nepriskirtų (unassigned) task'ų usage tyliai neįtraukia į `totals`, o `integrity.ok` nuo to nepriklauso. Padaryti unassigned usage matomą `BenchmarkIntegrity` struktūroje ir markdown ataskaitoje, kad darbo perkėlimas į frozen šablonų neatitinkančius task'us nebegalėtų „pagerinti“ metrikos be pėdsako.

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
- KRITINĖ DARBO TAISYKLĖ (2026-08-25, patikslinta pagal 020 diagnozę,
  docs/audits/020-session-writes-ledger-diagnosis-2026-08-25.md): ankstesnio bandymo darbą
  sunaikino R2 — Stop hook'o commit'as neįvyko iki dispatch pabaigos, ir rollback'as atsuko
  ledger'io matomą necommit'intą darbą. (Ankstesnė šio task'o pastaba kaltino subagentus —
  KLAIDINGAI: diagnozės įrodymas A rodo, kad subagento Edit rašymai ledger'į pasiekia.)
  Todėl: COMMIT'INK IŠ KARTO, kai tik patikros žalios — nepalik necommit'into darbo sesijos
  pabaigai. R1 fallback'as (020-a-02) jau saugo Bash kanalu rašytą darbą, bet R2 (task 021)
  dar atviras — ankstyvas commit'as yra vienintelė tikra apsauga.
- `capture-baseline.ts`: į `BenchmarkIntegrity` pridėti unassigned usage matomumą (`unassigned_usage_records` ir `unassigned_total_tokens`, skaičiuojant iš `usageByTask` prieš `continue`) ir sugriežtinti `ok` taip, kad unassigned task'as su usage > 0 duotų `ok: false`; sprendimą pagrįsti ataskaitoje.
- `baseline-report.ts`: naujus laukus atspausdinti integrity sekcijoje ir perskaityti parse'e taip, kad `parseBenchmarkReportMarkdown(render(x)) == x`, o senas baseline be naujų laukų toliau parsintųsi (default 0).
- `src/tests/**`: testai — task'as be case atitikmens su usage > 0 duoda `integrity.ok=false` ir nenulinius naujus laukus; unassigned be usage nelaužo `ok`; round-trip su naujais laukais; senas markdown be jų perskaitomas.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios ir failai ≤500 eilučių. Sustok po commit'o — comparability priežasties (`compareBenchmarkRuns`) šioje dalyje neliesti.

## Neįtraukta
- `token_basis` (raw vs billable) keitimas.
- Frozen konfigo `cases` keitimas.
- Queue loop vykdymas.
