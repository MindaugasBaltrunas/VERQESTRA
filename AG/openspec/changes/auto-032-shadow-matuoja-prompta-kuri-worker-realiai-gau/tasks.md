# Tasks

- [ ] readme-guard: perskaityti README ir architektūros ribas, patvirtinti `application/context-pack` ir `interfaces/http` scope.
- [ ] architect: nuspręsti, KUR skaičiuojamas sukompiliuoto PROMPT teksto ilgis (application shadow kelias vs interfaces sluoksnio rašomas laukas), kad `compiledPromptChars` nebūtų tiesiog `irJsonChars` po nauju vardu; užfiksuoti sprendimą design/tasks anotacijoje.
- [ ] schedule-domain/coder: pridėti `rawPromptChars`/`compiledPromptChars` laukus į `ContextCompressionMetricsInput`/`ContextCompressionMetrics` ir `COMPRESSION_METRIC_FIELDS` (`src/application/context-pack/metrics.ts`).
- [ ] coder: `persist.ts` viduje sutvarkyti kvietimų tvarką taip, kad naujos poros skaičiavimas naudotų TĄ PATĮ `executionContextBody`/`rendered.markdown`, kuris rašomas į `executionContextPath` — be antro render'io.
- [ ] coder: `ui-compression-view.ts` — nauji `ContextSizeSample` laukai, nauja `summarizeContextSizeSamples` suvestinė promptų porai, `decideCompression` persijungimas su fallback'u į seną IR logiką, nauji `reason` kodai.
- [ ] coder: `ui-app/src/**` — verdikto šaltinio laukų ir vertimų atnaujinimas naujiems `reason` kodams (be naujos skaičiavimo logikos klientėje).
- [ ] tester: `metrics.ts` — naujų laukų selektyvus rašymas/skaitymas (nesantis matavimas lieka nesantis).
- [ ] tester: `persist.ts` — naujos poros reikšmės sutampa su realiai parašytu execution context artefaktu; render'io kvietimų skaičius/byte-identiškumas.
- [ ] tester: `ui-compression-view.ts` — verdikto persijungimas (senos eilutės / naujos eilutės / mišrus rinkinys), `MIN_DECISION_SAMPLES` riba abiem poroms.
- [ ] tester: `ui-app` — vertimų/rodymo testai naujiems `reason` kodams.
- [ ] reviewer: patikrinti sluoksnių ribas (interfaces neimportuoja infrastructure; application nesikreipia į interfaces), kad `compiledPromptChars` šaltinis atitinka architekto sprendimą, ir kad senų laukų rašymas nenutrūko.
- [ ] Paleisti `pnpm typecheck`, `pnpm test`, `pnpm --dir ui-app test`; visi žali prieš commit.

## AG Queue Tasks
- 032-a: `metrics.ts` nauji laukai + testai (application sluoksnis, tester kartu).
- 032-b: `persist.ts` kvietimų tvarkos pertvarka + naujos poros skaičiavimas (priklauso nuo 032-a).
- 032-c: `ui-compression-view.ts` verdikto persijungimas + nauji reason kodai (priklauso nuo 032-a, gali suktis lygiagrečiai su 032-b, jei liečia tik `ui-compression-view.ts`).
- 032-d: `ui-app` vertimai naujiems reason kodams (priklauso nuo 032-c).
