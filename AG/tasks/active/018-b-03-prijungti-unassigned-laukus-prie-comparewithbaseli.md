# Task

## Spec source
openspec/changes/verqestra-backlog-v1 (`AG/openspec/changes/verqestra-backlog-v1/tasks.md`)

## Tikslas
`baseline-comparison.ts` projekcija į domain snapshot'ą perduoda tik `integrity_ok`. Prijungti anksčiau pridėtus unassigned integrity laukus, kad `compareWithBaseline` realiai matytų unassigned skirtumą ir jis pasiektų verdikto priežastis nuo galo iki galo.

## Agentai
Privaloma grandinė: `readme-guard -> coder -> reviewer -> tester`. readme-guard pirmas, be jo README ribų santraukos kodo nekeisti.

## Failai
Leidžiama:
- `src/application/benchmark/baseline-comparison.ts`
- `src/tests/**`

Draudžiama:
- `src/domain/metrics/comparison.ts`
- `src/application/benchmark/capture-baseline.ts`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Projekcijoje (ties `integrity_ok: report.integrity.ok`) perduoti unassigned task id'us ir tokenų sumą iš `report.integrity` į domain snapshot'ą.
- Užtikrinti, kad senas baseline be šių laukų projektuojasi be klaidos (default tuščia aibė / 0).
- `src/tests/**`: end-to-end testas — du report'ai su skirtingomis unassigned aibėmis ir usage > 0 duoda `not_comparable` su atitinkama priežastimi per `compareWithBaseline`.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios ir unassigned usage nebegali dingti be pėdsako nuo capture iki verdikto. Sustok po commit'o.

## Neįtraukta
- `token_basis` keitimas.
- Frozen konfigo `cases` keitimas.
- Queue loop vykdymas.
