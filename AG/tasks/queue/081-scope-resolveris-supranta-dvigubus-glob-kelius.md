# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 GeoGravity w1/w2 auditas — unknown-scope dėl `**` glob'ų: 21 iš 47 sequential degradacijų (P1, w2 enabler)

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei write-set nepriklausomybės vertinimas `allowed-paths` įrašą su `**`
(pvz. `modules/x/src/**`) paverčia apibrėžta katalogo aprėptimi
(`modules/x/src`) vietoj `unknown-scope — aprėptis neapibrėžta` —
ALREADY_IMPLEMENTED su eilučių įrodymu.

## Tikslas
GeoGravity log auditas (2026-08-29): 43 `unknown-scope — wildcard-scope:
allowed-paths: '...**' aprėptis neapibrėžta` paminėjimai, ≥20 užduočių,
**21 iš 47 `granted=1/2` sequential degradacijų** — antra pagal dydį w2
paralelizmo praradimo priežastis. GeoGravity task generatoriai rašo
`modules/<m>/src/**` formos kelius, o VERQESTRA scope resolver'is
(`conflict-detector.ts` / `worker-pool-admission.ts`) tokį įrašą laiko
neapibrėžtu ir FAIL-CLOSED atmeta antrą slot'ą.

Taisymas — ne silpninti, o APIBRĖŽTI: `<kelias>/**` (ir `<kelias>/*`)
normalizuojamas į `kind: directory, scope: <kelias>` — tą pačią formą,
kurią sankirtų vertinimas jau moka lyginti (dir/dir, file/dir). Plikas
`**` be prefikso arba `**` kelio VIDURYJE (`src/**/tests`) LIEKA
unknown-scope — jie tikrai neapibrėžti. Etalono taisyklė „konkretūs
keliai" galioja toliau; šis task'as tik paverčia dažną, semantiškai
aiškų atvejį teisinga aprėptimi vietoj lygiagretumo praradimo.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/conflict-detector.ts`
- `src/application/scheduling/worker-pool-admission.ts`
- `src/tests/scheduling-conflict-detector.test.ts` (numatomas; jei testas
  gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/application/scheduling/worker-pool-plan.ts` (077 jį valo — nesikirsti)
- `src/domain/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: patvirtinti, kad `evaluateWriteSetIndependence` verdiktų
  fixture'ai (jei pin'inti) keičiami sąmoningai — griežtinančia kryptimi
  (`unknown` → `directory` yra TIKSLESNĖ, ne laisvesnė aprėptis).
- Tester: `a/src/**` vs `a/src/x.ts` → konfliktas (dir/file); `a/src/**`
  vs `b/src/**` → nepriklausomi; plikas `**` → unknown-scope kaip dabar;
  `src/**/tests` → unknown-scope.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Testų nesilpninti — jei fixture pin'as
prieštarauja, stop ir klausk.

## Neįtraukta
Etalono taisyklių švelninimas (konkretūs keliai lieka norma). GeoGravity
task generatorių keitimas. `worker-pool-plan.ts` (077).
