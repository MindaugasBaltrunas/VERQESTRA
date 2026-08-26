# Tasks

- [ ] readme-guard: perskaityti README.md ir architektūros dokumentą, patvirtinti, kad `application/context-pack` ir `application/task-execution` ribos leidžia šį pakeitimą (application → application, domain, shared).
- [ ] architect: patvirtinti arba pakoreguoti design.md siūlomą sprendimą (`taskDerived` žyma + `excludeTaskDerived` parinktis + fallback `resolveCanonicalWorkerPrompt` viduje); ypač patvirtinti, kad fingerprint validacija PRIEŠ dedup lieka pririšta prie originalaus `gate.executionContext`, o ne prie perskaičiuoto varianto.
- [ ] schedule-domain/coder: `render-candidates.ts` — pridėti `Candidate.taskDerived?: true` penkiems kandidatams (`goal`, `acceptance-criteria`, `allowed-paths`, `checks`, `out-of-scope`); jokio kito lauko, tvarkos ar `body` skaičiavimo nekeisti.
- [ ] coder: `render-execution-context.ts` — pridėti `RenderExecutionContextOptions.excludeTaskDerived?: boolean`; kai `true`, filtruoti `taskDerived` kandidatus PRIEŠ `DROP_ORDER` ciklą; patikrinti, kad numatytas (nenurodytas) elgesys lieka baitas-į-baitą tapatus.
- [ ] coder: `execution-context-gate.ts` — `resolveCanonicalWorkerPrompt`: kai `gate.kind === "attach"`, bandyti `contextPackSchema.safeParse(input.contextPackText)`; sėkmės atveju sudaryti prompt'o kontekstą per `renderExecutionContext(pack, {excludeTaskDerived:true}).markdown`; nesėkmės/nebuvimo atveju naudoti nepakeistą `gate.executionContext`; `gate` grąžinamoje reikšmėje (fingerprint/validacijos rezultatas) NEKEISTI.
- [ ] coder: atnaujinti `worker-prompt-compilation.ts` ir `execution-context-gate.ts` modulio antraštes — įvardyti nukrypimą nuo etalono (2026-08-26, operatoriaus užsakymas), be produkcinio kodo pakeitimo antraštėse.
- [ ] reviewer: patikrinti importų ribas (jokio naujo importo už application sluoksnio), kad `contextPackSchema.safeParse` klaidos kelias visada fallback'ina saugiai (niekada nemeta neperimtos išimties į `resolveCanonicalWorkerPrompt` kvietėją), ir kad `context.dropped` semantika (varto header'io „N kept, M dropped" eilutė) neklaidina dėl task-derived pašalinimo.
- [ ] tester: regresinis testas — `renderExecutionContext(pack)` be naujos parinkties = tapatus `markdown` kaip prieš pakeitimą (bent vienam esamam fixture pack'ui).
- [ ] tester: naujas testas — `renderExecutionContext(pack, {excludeTaskDerived:true})` NETURI `## Goal`/`## Acceptance criteria`/`## Allowed paths`/`## Checks`/`## Out of scope` blokų, bet TURI visus kitus (spec, symbols, contracts, impacted tests, architecture, atitinkamus warnings).
- [ ] tester: naujas testas — `resolveCanonicalWorkerPrompt` su validžiu `contextPackText`: grąžintame `prompt` execution context sekcijoje NĖRA task-derived blokų, o task kūnas (`taskText`/`compiledTask`) juos ir toliau turi pilnai.
- [ ] tester: naujas testas — `resolveCanonicalWorkerPrompt` su trūkstamu arba sugadintu `contextPackText`: `prompt` lygus dabartiniam (fallback) elgesiui, joks turinys neprarandamas.
- [ ] tester: testas, matuojantis prompt'o dydžio (chars) sumažėjimą prieš/po dedup ant realaus arba fixture task pavyzdžio — dokumentuoti skaičių test'o assert'e arba komentare kaip regresijos apsaugą.
- [ ] tester: patvirtinti, kad esami `evaluateExecutionContextGate`/fingerprint/staleness testai (jei tokių yra `src/tests/**`) lieka žali be jokio pakeitimo.
- [ ] documenter: `pnpm typecheck && pnpm test` paleisti ir rezultatą įrašyti į commit'o ataskaitą; patvirtinti, kad `CONTEXT_CACHE_VERSION` NEKELIAMAS (disko artefaktas nepakitęs) ir tai paaiškinti ataskaitoje vienu sakiniu.

## AG Queue Tasks
- 030-worker-task-ir-vidinio-dubliavimo-taisymas (depends_on: 029) — IR vidinio dubliavimo taisymas, minėtas kaip Out Of Scope.
- 031-compiled-prompt-preambules-mazinimas (depends_on: none) — fiksuoto skaitymo rakto (WORKER_TASK_IR_PROMPT_HEADING / COMPACT_DSL_PROMPT_HEADING) dydžio mažinimas.
- 032-shadow-matavimo-poros-keitimas (depends_on: 029) — shadow/A-B matavimo poros atnaujinimas, kad atspindėtų naują (mažesnį) prompt'o dydį po dedup.
