# Task

## Spec source
openspec/changes/verqestra-backlog-v1 (`AG/openspec/changes/verqestra-backlog-v1/tasks.md`)

## Tikslas
`compareBenchmarkRuns` šiuo metu nemato, kad baseline ir current turi skirtingas nepriskirtų task'ų aibes. Padaryti, kad besiskirianti unassigned aibė su realiu usage patektų į verdikto `reasons` kaip comparability priežastis — prieš bet kokį delta skaičiavimą.

## Agentai
Privaloma grandinė: `readme-guard -> coder -> reviewer -> tester`. readme-guard pirmas, be jo README ribų santraukos kodo nekeisti.

## Failai
Leidžiama:
- `src/domain/metrics/comparison.ts`
- `src/tests/**`

Draudžiama:
- `src/application/benchmark/capture-baseline.ts`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Į comparable projekcijos tipą (`BenchmarkRunSnapshot`) pridėti opcionalų unassigned aprašą (task id'ai ir tokenų suma), suderinamą su `exactOptionalPropertyTypes`, kad senos projekcijos toliau kompiliuotųsi.
- Comparability bloke (šalia `integrity_ok` tikrinimų, prieš delta skaičiavimą) pridėti priežastį, kai baseline/current unassigned aibės skiriasi ir bent vienoje jų usage > 0.
- `src/tests/**`: testai — skirtinga unassigned aibė su usage duoda `not_comparable` ir priežastį; vienoda arba tuščia aibė verdikto nekeičia; snapshot be naujo lauko veikia kaip anksčiau.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. `src/domain` jokių `node:` importų. Sustok po commit'o — application projekcijos prijungimo šioje dalyje neliesti.

## Neįtraukta
- `token_basis` keitimas.
- Frozen konfigo `cases` keitimas.
- Queue loop vykdymas.
