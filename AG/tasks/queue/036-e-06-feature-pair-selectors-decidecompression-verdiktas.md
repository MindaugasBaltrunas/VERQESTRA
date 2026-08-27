# Task

## Spec source
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „`FEATURE_PAIR_SELECTORS` ... apibendrinanti esamą `selectIrPair`“)
- `src/interfaces/http/ui-compression-view.ts:174` (`selectIrPair`), `:287` (visos ne-`worker_task_ir` vėliavos gauna `"unmeasured"`)

## Tikslas
Vėliava, turinti savo shadow porą, gauna realų verdiktą pagal tą pačią logiką kaip `worker_task_ir` (moka / nemoka / trūksta mėginių); be poros — lieka `"unmeasured"` su `"no-shadow-measurement"`.

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-compression-view.ts`
- `src/tests/ui-compression-view.test.ts`

Draudžiama:
- `AG/**`
- `vq/**`
- `.env`
- `src/application/context-pack/**`
- `ui-app/src/**`

## Veiksmas
- Pakeisti `selectIrPair` lentele `ContextCompressionFeature -> (sample) => PairMeasurement | undefined`, apimančia visas penkias vėliavas; `decideCompression` ir `summarizeContextSizeSamples` dirba prieš lentelę, o ne prieš vieną hardkodintą atvejį.
- `worker_task_ir` verdiktas privalo likti BITIŠKAI tapatus — tai regresijos riba, ne detalė.
- Testuose padengti: `worker_task_ir` tapatumo regresijos testas plius kiekvienai iš keturių vėliavų — teisingas verdiktas su pora ir `"unmeasured"`/`"no-shadow-measurement"` be jos.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok, jei apibendrinimas pakeistų `worker_task_ir` verdiktą bent viename mėginyje arba jei `ui-compression-view.ts` viršytų 500 eilučių ribą (tada reikia atskiro failo — klausk).

## Neįtraukta
- Matavimų rašytojai (ankstesni darbai).
- `ui-app` vertimai naujoms `reason` reikšmėms (kitas darbas).
- Vėliavų įjungimas.
