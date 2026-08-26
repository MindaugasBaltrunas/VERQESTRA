# Spec Delta

## Added
- `ContextCompressionMetricsInput`/`ContextCompressionMetrics` (`metrics.ts`): du nauji OPCIONALŪS laukai — `rawPromptChars`/`raw_prompt_chars` ir `compiledPromptChars`/`compiled_prompt_chars` — abu matuojami TO PATIES execution context'o atžvilgiu, kurį realus dispatch prisegs.
- `COMPRESSION_METRIC_FIELDS` lentelėje (`metrics.ts:103-114`) — dvi naujos eilutės naujai porai, per tą pačią `selectCompressionMetrics`/`readCompressionMetrics` mechaniką (be pakeitimų validacijos logikoje).
- `ContextSizeSample` (`ui-compression-view.ts:41-51`) — nauji neprivalomi laukai `raw_prompt_chars`/`compiled_prompt_chars`.
- `UiCompressionTelemetry` — nauji laukai analogiški `ir_compared_count`/`ir_smaller_count`/`avg_ir_delta_percent`, bet prompt lygiui (`prompt_compared_count`, `prompt_smaller_count`, `avg_prompt_delta_percent`).
- Nauji `UiCompressionRecommendation.reason` kodai, įvardijantys PROMPT palyginimą (`prompt-larger-on-average`, `prompt-smaller-under-pressure`, `prompt-smaller-no-pressure`, `too-few-prompt-comparisons`).
- Testai: `persist.ts` naujos poros skaičiavimui (su tuo pačiu execution context'u, be antro render'io), `metrics.ts` naujų laukų selektyviam rašymui/skaitymui, `ui-compression-view.ts` verdikto persijungimui tarp senos ir naujos poros.

## Changed
- `persist.ts`: `appendContextSizeMetrics` kvietimo vieta/tvarka santykyje su `renderExecutionContext`, kad nauja pora naudotų JAU surenderintą, į diską rašomą execution context'ą — ne antrą, atskirą render'į.
- `decideCompression` (`ui-compression-view.ts:217-238`): kai `prompt_compared_count >= MIN_DECISION_SAMPLES`, verdiktas skaičiuojamas iš PROMPT poros; priešingu atveju (senos eilutės be naujų laukų arba per mažai mėginių) — esama `ir_*` logika lieka fallback'u, joks lūžis.
- `ui-app` verdikto vertimai: nauji `reason` kodai gauna tekstus, aiškiai įvardijančius, kad lyginamas PILNAS prompt'as (kūnas + execution context), o ne vien IR JSON.

## Acceptance Criteria
- Senos `context-size.jsonl` eilutės (be naujų laukų) toliau skaitomos be klaidų; `decideCompression` joms grąžina TĄ PATĮ verdiktą kaip prieš pakeitimą (regresijos testas dengia šį atvejį).
- Naujos eilutės turi `raw_prompt_chars`/`compiled_prompt_chars` TIK kai abu dydžiai realiai išmatuoti; kai matavimas neįmanomas (pvz. shadow kompiliavimas nepavyko), laukai NESANTYS, ne `0`.
- `raw_prompt_chars` ir `compiled_prompt_chars` abu apima TĄ PATĮ execution context turinį, kuris parašytas į `executionContextPath` tam pačiam dispatch'ui (patikrinama testu, lyginant reikšmę su realiai parašyto failo ilgiu).
- `execution-context.md` renderinamas LYGIAI vieną kartą vienam `persistContextPack` kvietimui (nėra antro `renderExecutionContext` iškvietimo vien telemetrijai) — testas patvirtina render funkcijos kvietimų skaičių arba tikrina rezultatų byte-identiškumą su realiu artefaktu.
- Kai naujos poros mėginių pakanka (`prompt_compared_count >= MIN_DECISION_SAMPLES`), UI verdiktas naudoja JĄ, o ne seną IR JSON porą; priešingu atveju rodomas dabartinis elgesys.
- `MIN_DECISION_SAMPLES` ir spaudimo lygių konstantos (`PRESSURE_HIGH_MAX_PERCENT`, `PRESSURE_MODERATE_AVG_PERCENT`, `PRESSURE_MODERATE_MAX_PERCENT`) nepakeistos.
- `pnpm typecheck`, `pnpm test`, `pnpm --dir ui-app test` žali.
- Jokie `AG/**`, `vq/**` failai nepakeisti šio task'o metu.
