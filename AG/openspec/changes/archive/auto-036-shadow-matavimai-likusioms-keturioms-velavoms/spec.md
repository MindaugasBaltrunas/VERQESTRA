# Spec Delta

## Added
- `ContextCompressionMetricsInput`/`ContextCompressionMetrics`/`COMPRESSION_METRIC_FIELDS` (`src/application/context-pack/metrics.ts`): nauji NEPRIVALOMI laukų porų įrašai dispatch_tool_schema (pvz. `toolSchemaFullChars`/`tool_schema_full_chars`, `toolSchemaReducedChars`/`tool_schema_reduced_chars`) ir compact_dsl (pvz. `dslIrChars`/`dsl_ir_chars`, `dslCompiledChars`/`dsl_compiled_chars`). Tikslūs pavadinimai priklauso nuo architect sprendimo, bet privalo eiti per vieną lentelę, ne šalutinius spread'us.
- Rašytojas `toolRawChars`/`toolDigestChars` laukams: PostToolUse Bash shadow kelias (`src/interfaces/hooks/post-hooks.ts`) papildomai rašo į `context-size.jsonl` per `task_id`.
- Surinkimo-meto (ne tik finalizuoto pack'o) SRC/SIG dydžių skaičiavimas `gather.ts`/`tiers.ts`/`persist.ts` kelyje, veikiantis nepriklausomai nuo `symbol_slices` vėliavos būsenos.
- Dispatch paruošimo shadow matavimas: pilnos vs sumažintos MCP tool schemos dydis (naujas skaičiavimo taškas šalia esamo `toolSchema.candidates`/`applied` rinkimo).
- `compact_dsl` poros pratekinimas iš `compact-dsl/render.ts` į `context-size.jsonl`.
- `FEATURE_PAIR_SELECTORS` (ar analogiškas pavadinimas) — lentelė `ContextCompressionFeature -> (sample) => PairMeasurement | undefined` `ui-compression-view.ts` faile, apibendrinanti esamą `selectIrPair`.
- Nauji UI (`ui-app`) vertimai `reason` reikšmėms, kai jos taikomos vėliavoms, kurių pavadinimas anksčiau nebuvo tekste (pvz. "kompresuotas" vietoj kietai koduoto "IR").

## Changed
- `summarizeContextSizeSamples` (`ui-compression-view.ts`): apibendrinama skaičiuoti `compared_count`/`smaller_count`/`avg_delta_percent` PER vėliavą, ne tik `ir_*` laukus; grąžinamos struktūros forma keičiasi (naujas per-vėliavos žemėlapis arba analogiškų laukų rinkinys penkioms vėliavoms), bet esami `ir_*` laukai IR jų reikšmės `worker_task_ir` vėliavai lieka bitiškai identiški.
- `decideCompression`: vietoj hardcoded `irAction` šakos + likusių keturių automatinio `"unmeasured"`, kiekviena vėliava iš `CONTEXT_COMPRESSION_FEATURES` eina per tą pačią moka/nemoka/trūksta-mėginių logiką, naudodama savo poros selektorių, jei toks yra.
- `src/application/context-pack/assemble/persist.ts` ir `tiers.ts`: SRC/SIG dydžių skaičiavimas perkeliamas iš "po tier sprendimo" į "surinkimo metu, visada".
- `src/interfaces/hooks/post-hooks.ts`: `recordBashDigestShadow` papildomai rašo į `context-size.jsonl`, be pakeitimo tam, kas grąžinama darbuotojui (fail-safe, best-effort, kaip ir esamas `bash-digest-shadow.jsonl` rašymas).

## Acceptance Criteria
- [ ] Kiekviena iš keturių anksčiau neišmatuotų vėliavų (`bash_output_digest`, `symbol_slices`, `dispatch_tool_schema`, `compact_dsl`) turi bent vieną naują arba užpildytą shadow porą, rašomą per `COMPRESSION_METRIC_FIELDS`.
- [ ] Visi nauji laukai NEPRIVALOMI: nesantis matavimas serializuojasi kaip lauko NEBUVIMAS JSONL eilutėje, ne `0`.
- [ ] `decideCompression` grąžina realų verdiktą (`enable`/`optional`/`hold`/`insufficient`) kiekvienai vėliavai, turinčiai pakankamai mėginių su pora; be poros arba nepakankamai mėginių — `"unmeasured"`/`"insufficient"`, kaip šiandien.
- [ ] `worker_task_ir` verdikto rezultatas ESAMIEMS `context-size.jsonl` mėginiams nepasikeičia po `decideCompression` apibendrinimo (regresijos testas ant esamo fixture rinkinio).
- [ ] Nė vienas naujas shadow matavimas nepakeičia realiai perduodamo turinio (Bash tool output, worker prompt, dispatch schema, DSL dokumentas) — flag'ui esant išjungtam, elgesys identiškas prieš ir po pakeitimo.
- [ ] `symbol_source_chars`/`symbol_signature_chars` rašomi net kai pack'as renderinamas be tier'ų (t. y. `symbol_slices` išjungtas).
- [ ] `bash-digest-shadow.jsonl` rašymo elgesys (esamas žurnalas) NESIKEIČIA — naujas rašymas į `context-size.jsonl` yra PAPILDOMAS, ne pakeičiantis.
- [ ] `CONTEXT_CACHE_VERSION` nepakeltas (telemetrija, ne pack turinys) — arba, jei įrodoma, kad kuris nors matavimas paveikia realų pack sprendimą, task'as sustoja prieš tai eskaluodamas, o ne kelia versiją tyliai.
- [ ] `ui-app` verdikto priežasčių vertimai apima visas naujas `reason`/vėliavos kombinacijas, kurios gali pasirodyti UI puslapyje.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm --dir ui-app test` žali.
