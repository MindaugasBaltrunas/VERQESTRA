# Design

## Approach
1. **Vieno-įrašo lentelė lieka autoritetas.** Kiekviena nauja pora (jei jos dar nėra) pridedama į `ContextCompressionMetricsInput`/`ContextCompressionMetrics`/`COMPRESSION_METRIC_FIELDS` (`metrics.ts`) tuo pačiu būdu, kaip 032 pridėjo `rawPromptChars`/`compiledPromptChars`: NEPRIVALOMI laukai, `undefined` reiškia "nematuota", niekada `0`. `dispatch_tool_schema` porai reikės NAUJŲ laukų (pvz. `toolSchemaFullChars`/`toolSchemaReducedChars`) — pridedami ta pačia tvarka. `bash_output_digest` porai laukai JAU egzistuoja (`toolRawChars`/`toolDigestChars`) — trūksta tik rašytojo. `compact_dsl` porai reikės naujų laukų (pvz. `dslIrChars`/`dslCompiledChars`), nes esami `irJsonChars`/`compiledTaskChars` jau priklauso `worker_task_ir` porai ir jų pakartotinis naudojimas maišytų dvi skirtingas vėliavas.
2. **Kiekvienas matavimas — savo esamo kelio shadow atšaka, ne naujas kelias:**
   - `bash_output_digest`: `post-hooks.ts` `recordBashDigestShadow` jau turi `digest` ir `rawText` reikšmes prieš rašydama į `bash-digest-shadow.jsonl` — ta pati funkcija papildomai iškviečia `appendContextSizeMetrics` (arba lygiavertį portą) su `task_id`, gautu iš hook'o konteksto, jei jis prieinamas; jei task_id nėra prieinamas šiame taške, tai FAKTAS, kurį reikia užfiksuoti proposal peržiūroje, o ne apeiti fallback'u.
   - `symbol_slices`: `gather.ts`/`tiers.ts` skaičiuoja SRC/SIG dydžius VISADA surinkimo metu (ne tik kai `symbol_slices` įjungtas), pernešant esamą `persist.ts:115-127` sumavimo logiką aukščiau — prieš tai, kai sprendimas rodyti tier'us ar ne yra priimtas.
   - `dispatch_tool_schema`: dispatch paruošimo taškas (kur šiandien renkamas `toolSchema.candidates`/`applied`, žr. `agent-policy.ts`/`dispatch-adapters.ts`) papildomai suskaičiuoja pilnos schemos JSON dydį ir taikomos (sumažintos) schemos JSON dydį — abu, nepriklausomai nuo to, ar `dispatch_tool_schema` įjungtas.
   - `compact_dsl`: `compact-dsl/render.ts` `renderCompactWorkerDsl` jau turi IR ir kompiliuotą DSL dokumentą vienoje funkcijoje — grąžinama pora (arba kvietėjas `persist.ts`/atitinkamas assembly taškas ją nuskaito) ir prijungiama prie to paties `context-size.jsonl` įrašo per `COMPRESSION_METRIC_FIELDS`.
3. **`decideCompression` apibendrinimas.** Vietoj hardcoded `irAction` funkcijos (`ui-compression-view.ts:271-282`), lentelė `FEATURE_PAIR_SELECTORS: Record<ContextCompressionFeature, (sample) => PairMeasurement | undefined>` — po vieną selektorių kiekvienai vėliavai (analogiška `selectIrPair`, bet be `worker_task_ir` hardcode'o). `summarizeContextSizeSamples` apibendrinamas skaičiuoti `compared_count`/`smaller_count`/`avg_delta_percent` PER vėliavą, ne tik `ir_*`. Vėliavos be selektoriaus poros (arba be duomenų mėginiuose) lieka `"unmeasured"` — esamas fallback elgesys keturioms vėliavoms NESIKEIČIA tol, kol jų rašytojas neįdiegtas; kai įdiegtas, jos automatiškai patenka į tą pačią moka/nemoka logiką kaip šiandien `worker_task_ir`.
4. **UI vertimai.** `ui-app` verdikto priežasčių žemėlapis (jei jame yra fiksuotas `reason` → tekstas sąrašas TIK `worker_task_ir` atvejui) išplečiamas bendram atvejui — tas pats penkių `reason` kodų rinkinys (`ir-larger-on-average` ir kt.) galios visoms penkioms vėliavoms, tad UI pusėje keičiasi nebent tekstas, kuris šiuo metu kietai koduoja "IR" terminą ("IR mažesnis" turi tapti bendriniu "kompresuotas mažesnis").

## Data Flow
```text
PostToolUse Bash hook ──(shadow, flag skaitomas TIK sprendimui rašyti ar ne)──> context-size.jsonl:
  tool_raw_chars, tool_digest_chars

context-pack gather/tiers ──(visada, prieš tier sprendimą)──> persist.ts ──> context-size.jsonl:
  symbol_source_chars, symbol_signature_chars (nebe tik kai tier'ai jau priskirti)

dispatch paruošimas ──(shadow, prieš taikant sumažinimą)──> context-size.jsonl:
  [nauji laukai] tool_schema_full_chars, tool_schema_reduced_chars

compact-dsl render ──(esama pora perkeliama)──> context-size.jsonl:
  [nauji laukai] dsl_ir_chars, dsl_compiled_chars

context-size.jsonl ──(readContextSizeMetrics)──> ui-compression-view.ts:
  summarizeContextSizeSamples (apibendrinta per vėliavą)
  ──> decideCompression (apibendrinta lentelė)
  ──> UiCompressionRecommendation[] (visos 5 vėliavos, ne tik worker_task_ir)
  ──> ui-app (naujų reason tekstų vertimas)
```

## Risks
- **Elgesio pokytis pačiame dispatch/hook kelyje.** Kiekvienas naujas matavimas privalo būti "nemokamas elgesio prasme" (užduoties Stop sąlyga) — jei schemos dydžio ar DSL poros skaičiavimas dispatch paruošimo metu pastebimai lėtina kelią arba pakeičia siunčiamą turinį, task'as sustoja ir eskaluoja, o ne apeina matavimu.
- **`task_id` prieinamumas PostToolUse Bash hook'e.** `recordBashDigestShadow` šiandien rašo be `task_id` susiejimo su `context-size.jsonl` schema (kuriai `task_id` yra privalomas laukas). Jei hook'o kontekste task_id nėra tiesiogiai prieinamas, reikia FAKTO patikrinimo prieš implementaciją — tai architect/schedule-domain sprendimas, ne spėjimas šiame OpenSpec.
- **`CONTEXT_CACHE_VERSION` NEKELIAMAS.** Šie matavimai nekeičia to, kas patenka į context pack'ą, retrieval'ą, reitingavimą ar biudžetą — tai telemetrija ŠALIA pack'o, ne jo turinio dalis. Rizika — implementacija per klaidą sumaišo shadow skaičiavimą su realiu pack turiniu (pvz. simbolių pjūvių shadow skaičiavimas per gather netyčia paveikia realų atrankos sprendimą) — tokiu atveju versijos pakėlimas TAPTŲ reikalingas ir tai yra stabdymo sąlyga, ne default.
- **Schema drift tarp rašytojo ir skaitytojo.** Nauji laukai eina per `COMPRESSION_METRIC_FIELDS`, kuri jau garantuoja simetriją tarp `selectCompressionMetrics`/`readCompressionMetrics` — rizika minimizuota esama architektūra, bet naujiems laukų vardams (dispatch_tool_schema, compact_dsl poroms) reikia vengti susikirtimo su esamais `raw_task_chars`/`compiled_task_chars`/`ir_json_chars` pavadinimais, kurie jau priklauso `worker_task_ir` porai.
- **`decideCompression` apibendrinimas gali pakeisti esamą `worker_task_ir` verdikto tekstą/formą.** Refaktoringas privalo išlaikyti byte-for-byte tą patį `worker_task_ir` verdiktą esamiems mėginiams (regresijos testas ant esamų fixture'ų prieš ir po apibendrinimo).
- **`dispatch_tool_schema` visada `false` reikšmė testų fixture'uose** (`compression-policy-verdicts.json`) rodo, kad ji niekada nebuvo aktyviai testuota canary/A-B scenarijuje — shadow matavimo įdiegimas neturi remtis prielaida, kad ji kada nors buvo įjungta produkcijoje.
