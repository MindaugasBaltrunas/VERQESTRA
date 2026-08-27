# Spec Delta

## Added

- `ContextCompressionMetricsInput` (`src/application/context-pack/metrics.ts`): du nauji
  NEPRIVALOMI laukai:
  - `promptCharsRawShadow?: number` — raw task kūnas + execution context, joks jų
    nekompiliuotas; TAS PATS sujungimo kelias, kurį naudotų realus dispatch'as be
    kompresijos.
  - `promptCharsCompiledShadow?: number` — kompiliuotas (WorkerTaskIR/compiled task
    tekstas) kūnas + TAS PATS execution context.
- `ContextCompressionMetrics` (record-side, snake_case): atitinkami
  `prompt_chars_raw_shadow?: number` ir `prompt_chars_compiled_shadow?: number`,
  registruoti `COMPRESSION_METRIC_FIELDS` lentelėje pagal esamą konvenciją (vienas
  raktas — vienoje vietoje, rašymo ir skaitymo pusės negali išsiskirti).
- `persist.ts`: shadow apskaičiavimas abiem prompt'o variantams, kviečiant TĄ PAČIĄ
  sujungimo funkciją (`resolveCanonicalWorkerPrompt` arba jos vidinį pod-žingsnį iš
  `application/task-execution/execution-context-gate.ts`) su TUO PAČIU jau paskaičiuotu
  execution context markdown'u (`rendered.markdown`). Abu laukai absent, kai gate
  rezultatas nėra `attach`, arba kai `workerTaskIr` nėra (compiled pusei).
- `ui-compression-view.ts`:
  - `ContextSizeSample` tipas praplėstas dviem naujais neprivalomais laukais
    (`prompt_chars_raw_shadow`, `prompt_chars_compiled_shadow`).
  - `UiCompressionTelemetry` praplėstas: `prompt_compared_count: number`,
    `prompt_smaller_count: number`, `avg_prompt_delta_percent?: number` — ta pati
    skaičiavimo logika kaip esamai IR porai (`percent`, `average` pagalbinės funkcijos
    pernaudojamos, ne dubliuojamos).
  - `UiCompressionRecommendation.reason` unija praplėsta naujomis stabiliomis
    priežastimis, atspindinčiomis prompt'o lygio sprendimą (pvz.
    `"prompt-larger-on-average"`, `"prompt-smaller-under-pressure"`,
    `"prompt-smaller-no-pressure"`, `"too-few-prompt-comparisons"`) — laisvo teksto
    logika NEKEIČIAMA, tik kodų rinkinys.

## Changed

- `decideCompression` (`ui-compression-view.ts`): `worker_task_ir` rekomendacija
  perskaičiuojama iš prompt'o lygio poros, KAI `telemetry.prompt_compared_count >=
  MIN_DECISION_SAMPLES`. Kai mėginių nepakanka arba jų nėra (senas log'as be naujų
  laukų), rekomendacija lieka esama — apskaičiuota iš `raw_task_chars`/
  `compiled_task_chars` (IR) poros, nepakitusi. `MIN_DECISION_SAMPLES` ir spaudimo lygių
  slenksčiai (`decidePressure`) NESIKEIČIA.
- UI vertimai/sakiniai (`ui-app/src/**`), kurie šiandien įvardija palyginimą kaip „IR
  kūno" dydį, atnaujinami įvardyti, kad sprendimas remiasi PILNU prompt'u (kūnas +
  kontekstas), kai tokių duomenų yra; likę sakiniai (spaudimo lygis, `unmeasured`
  vėliavos) nekeičiami.

## Acceptance Criteria

- Senas `context-size.jsonl` įrašas (be `prompt_chars_raw_shadow`/
  `prompt_chars_compiled_shadow`) toliau parsinamas be klaidos, o
  `summarizeContextSizeSamples` grąžina `prompt_compared_count: 0` tokiai eilutei —
  nulis reiškia „nematuota", ne „lygu".
- Naujas assembly (cache hit IR miss keliai abu) su egzistuojančiu `workerTaskIr` ir
  gate rezultatu `attach` prirašo abu naujus laukus su teigiamomis, baigtinėmis
  reikšmėmis; be `workerTaskIr` arba su gate `skip`/`refuse` — abu laukai absent (ne 0,
  ne `null`).
- Shadow raw ir shadow compiled prompt'o skaičiavimas naudoja IDENTIŠKĄ execution
  context markdown'ą (tas pats string abiem kvietimams) — testas turi tai patvirtinti
  tiesiogiai (pvz. spy/stub ant sujungimo funkcijos ar bent turinio lygybės patikra),
  ne vien skaičiaus lygybę per atsitiktinumą.
- `worker_prompt_chars`/`compiled_task_chars`/`raw_task_chars`/`ir_json_chars` laukai ir
  jų esami rašytojai/skaitytojai lieka BAIT UŽ BAITO nepakitę — joks esamas testas šiuos
  laukus tikrinantis nesulūžta.
- `decideCompression`: mėginių rinkinys su `prompt_compared_count >= MIN_DECISION_SAMPLES`
  duoda kitokį (ar tą patį, priklausomai nuo duomenų) verdiktą nei vien IR pora būtų
  davusi tais pačiais duomenimis — testas įrodo, kad naudojama BŪTENT prompt'o pora, ne
  senoji, kai abi yra.
- `decideCompression` be prompt'o poros duomenų (arba su `prompt_compared_count <
  MIN_DECISION_SAMPLES`) grąžina TĄ PATĮ verdiktą, kaip prieš šį pakeitimą, identiškais
  senais duomenimis — regresijos testas prieš esamą elgesį.
- `pnpm typecheck && pnpm test && pnpm --dir ui-app test` — visi žali.
