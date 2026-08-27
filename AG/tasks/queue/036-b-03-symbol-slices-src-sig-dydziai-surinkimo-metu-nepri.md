# Task

## Spec source
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „Surinkimo-meto ... SRC/SIG dydžių skaičiavimas“)
- `src/application/context-pack/assemble/persist.ts:94-117` — šiandien rašoma tik kai `symbolFragments.some(tier !== undefined)`

## Tikslas
`symbol_source_chars`/`symbol_signature_chars` pora skaičiuojama surinkimo metu ir rašoma VISADA, net kai pack'as renderinamas be tier'ų — kad operatorius galėtų sužinoti, ar verta jungti `symbol_slices`, jos nesujungęs.

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/persist.ts`
- `src/application/context-pack/assemble/gather.ts`
- `src/application/context-pack/assemble/tiers.ts`
- `src/tests/context-pack-metrics.test.ts`

Draudžiama:
- `AG/**`
- `vq/**`
- `.env`
- `src/interfaces/**`
- `ui-app/src/**`

## Veiksmas
- Perkelti SRC/SIG dydžių skaičiavimą iš „po tier sprendimo“ į „visada surinkimo metu“: abu dydžiai gaunami iš turimų symbol fragmentų, nepriklausomai nuo `symbol_slices` vėliavos būsenos.
- Renderinamas pack'o turinys nesikeičia — keičiasi tik matavimo momentas ir sąlyga. Jei pack'o turinys vis dėlto keistųsi, kelti `CONTEXT_CACHE_VERSION`; jei nesikeičia — nekelti.
- Testuose padengti: pora rašoma kai vėliava išjungta (tier'ų nėra), pora išlieka nepakitusi kai vėliava įjungta, ir failai lieka ≤500 eilučių.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok, jei matavimo perkėlimas reikalautų pakeisti realiai renderinamą pack'o turinį arba matuojamai sulėtintų surinkimą.

## Neįtraukta
- `bash_output_digest`, `dispatch_tool_schema`, `compact_dsl` rašytojai.
- `decideCompression` verdiktas ir `ui-app` vertimai.
- `symbol_slices` vėliavos įjungimas.
