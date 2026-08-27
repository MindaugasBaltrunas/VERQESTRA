## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „FEATURE_PAIR_SELECTORS ... apibendrinanti esamą selectIrPair“)
- `src/interfaces/http/ui-compression-view.ts:174` (`selectIrPair`), `:287` (visos ne-worker_task_ir vėliavos gauna "unmeasured")

## Tikslas
Vėliava, turinti savo shadow porą `context-size.jsonl` mėginyje, gauna realų verdiktą pagal tą pačią logiką kaip `worker_task_ir` (enable/optional/hold/insufficient); be poros — lieka `"unmeasured"` su `"no-shadow-measurement"`.

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
- Pakeisti `selectIrPair` bendra lentele `FEATURE_PAIR_SELECTORS: ContextCompressionFeature -> (sample) => PairMeasurement | undefined`, apimančia visas penkias vėliavas per jau egzistuojančius `ContextSizeSample`/`ContextCompressionMetrics` laukus (`tool_raw_chars`/`tool_digest_chars`, `symbol_source_chars`/`symbol_signature_chars`, `tool_schema_full_chars`/`tool_schema_reduced_chars`, `dsl_ir_chars`/`dsl_compiled_chars`); `decideCompression` ir `summarizeContextSizeSamples` dirba per šią lentelę, ne prieš vieną hardkodintą atvejį.
- `worker_task_ir` verdiktas ir jo `pair` reikšmė privalo likti BITIŠKAI tapatūs esamai logikai (prompt pora > task pora fallback) — tai regresijos riba, ne detalė.
- Papildyti `ContextSizeSample` tipą trūkstamais laukais keturioms vėliavoms, kad jie būtų skaitomi iš JSONL eilutės.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok, jei apibendrinimas pakeistų `worker_task_ir` verdiktą bent viename mėginyje arba jei `ui-compression-view.ts` viršytų 500 eilučių ribą (tada reikia atskiro failo — klausk).

## Neįtraukta
- Matavimų rašytojai (`post-hooks.ts`, `gather.ts`/`tiers.ts`, dispatch paruošimo taškas) — ankstesni/atskiri darbai.
- `ui-app` vertimai naujoms `reason` reikšmėms (kitas darbas).
- Vėliavų įjungimas gamyboje.
