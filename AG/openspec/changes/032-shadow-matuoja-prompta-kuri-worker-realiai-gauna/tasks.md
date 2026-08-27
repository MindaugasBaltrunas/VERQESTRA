# Tasks

- [ ] Patvirtinti PRIEŠ kodavimą: ar `resolveCanonicalWorkerPrompt` (arba jos vidinis
      sujungimo žingsnis) `application/task-execution/execution-context-gate.ts` gali
      būti iškviestas iš `persist.ts` be papildomų IO priklausomybių (stale source
      slices patikros), kurių assembly metu nėra. Jei reikalautų antro execution
      context render'io su kitokia semantika arba dirbtinio „unchecked" žymėjimo, kuris
      keistų gate rezultatą — STOTI, eskaluoti architect'ui pagal task Stop sąlygą,
      NErašyti kopijos.
- [ ] `src/application/context-pack/metrics.ts`: pridėti
      `promptCharsRawShadow`/`promptCharsCompiledShadow` į
      `ContextCompressionMetricsInput`, `prompt_chars_raw_shadow`/
      `prompt_chars_compiled_shadow` į `ContextCompressionMetrics`, įrašyti abu į
      `COMPRESSION_METRIC_FIELDS` lentelę. Patikrinti, kad `selectCompressionMetrics`/
      `readCompressionMetrics` validacija (baigtinis ne-neigiamas skaičius) veikia
      naujiems laukams be papildomo kodo (lentelės pakeitimo turėtų pakakti).
- [ ] `src/application/context-pack/assemble/persist.ts`: apskaičiuoti shadow raw ir
      shadow compiled prompt'o dydžius, naudojant `rendered.markdown` (jau esantį
      execution context) ir arba `input.taskText` (raw), arba `workerTaskIr`
      kompiliuotą formą, per `resolveCanonicalWorkerPrompt`. Absent, kai gate ne
      `attach` arba `workerTaskIr` nėra. Perduoti į `buildContextSizeMetrics` kaip
      papildomus lauko-optional spread'us (esama `...(x === undefined ? {} : {x})`
      konvencija).
- [ ] `src/interfaces/http/ui-compression-view.ts`: praplėsti `ContextSizeSample`,
      `UiCompressionTelemetry`, `summarizeContextSizeSamples` (nauja prompt'o pora),
      `UiCompressionRecommendation.reason` unija ir `decideCompression` (fallback logika
      tarp prompt'o poros ir esamos IR poros pagal `MIN_DECISION_SAMPLES`).
- [ ] `ui-app/src/**`: atnaujinti verdikto sakinių vertimus, kad įvardytų prompt'o lygio
      palyginimą, kai jis naudojamas; nekeisti UI struktūros ar naujų komponentų.
- [ ] Testai (`src/tests/**`): nauji unit testai `metrics.ts` laukų round-trip
      (write→read), `persist.ts` shadow apskaičiavimo (identiškas execution context abiem
      pusėms, absent kai gate ne-attach/be IR), `ui-compression-view.ts`
      `summarizeContextSizeSamples`/`decideCompression` (nauja pora naudojama kai
      pakanka mėginių, fallback kai ne, legacy log be regreso).
- [ ] `pnpm typecheck && pnpm test && pnpm --dir ui-app test` — visi žali.
- [ ] Commit'o ataskaitoje ir `migration-coverage.json` pažymėti, jei nukrypstama nuo
      etalono elgesio (šis task'as etalone `AG_loop` panašaus shadow prompt'o
      matavimo neturi — tai naujas, griežtinantis matavimas, ne spraga).

## AG Queue Tasks

- Priklauso nuo: `041-sprendimo-task-id-antspauduojamas-o-ne-patikimas-modeliu.md`
  (jau nurodyta task apraše kaip `depends_on`).
- Po šio task'o: joks naujas queue įrašas automatiškai negeneruojamas; jei
  implementacijos metu paaiškės, kad reikalingas realaus dispatch'o
  `worker_prompt_chars` rašytojas (interfaces/dispatch sluoksnis) tam, kad
  `post-run-truth-join.ts` pradėtų veikti — tai ATSKIRAS task'as, ne šio dalis (žr.
  Proposal → Out Of Scope).
