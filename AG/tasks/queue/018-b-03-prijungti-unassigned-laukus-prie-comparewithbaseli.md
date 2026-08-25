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
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
`baseline-comparison.ts` projekcija perduoda domain snapshot'ui tik `integrity_ok`. Reikia prijungti anksčiau pridėtus unassigned integrity laukus (task id'us ir tokenų sumą) iš `report.integrity`, kad `compareWithBaseline` matytų unassigned skirtumą ir jis pasiektų verdikto priežastis nuo galo iki galo.

## Agentai
readme-guard -> coder -> reviewer -> tester (privaloma tvarka, readme-guard pirmas)

## Failai
Leidžiama:
- `src/application/benchmark/baseline-comparison.ts`
- `src/tests/**`

Draudžiama:
- `src/domain/metrics/comparison.ts`
- `src/application/benchmark/capture-baseline.ts`

## Veiksmas
- Ties `integrity_ok: report.integrity.ok` projekcijoje prijungti unassigned task id'us ir tokenų sumą iš `report.integrity` į domain snapshot'ą.
- Užtikrinti, kad senas baseline be šių laukų projektuojasi be klaidos (default tuščia aibė / 0).
- Parašyti end-to-end testą: du report'ai su skirtingomis unassigned aibėmis ir usage > 0 duoda `not_comparable` su atitinkama priežastimi per `compareWithBaseline`.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios ir unassigned usage nebegali dingti be pėdsako nuo capture iki verdikto. Sustok po commit'o.

## Neįtraukta
- `token_basis` keitimas.
- Frozen konfigo `cases` keitimas.
- Queue loop vykdymas.
