# Tasks

- [ ] readme-guard: perskaityti README.md ir architektūros dokumentą, patvirtinti `application/context-pack` ribas ir grąžinti santrauką tolesniems agentams.
- [ ] architect: peržiūrėti `worker-prompt-compilation.ts:246-289` ir `compact-dsl/render.ts` markerių sąrašą; nuspręsti, ar legendos tekstas gali būti išvedamas iš bendro markerių apibrėžimo, ar lieka atskiras string literalas su testu, kuris juos sulygina; fiksuoti tikslų sutrumpintos IR ir DSL preambulės tekstą.
- [ ] coder: sutrumpinti `renderWorkerTaskIrPrompt` preambulę (worker-prompt-compilation.ts:262-266) iki architect'o patvirtinto teksto, nekeičiant antraštės/task_id/fence struktūros.
- [ ] coder: glaudinti `renderCompactWorkerDslPrompt` markerių legendą (worker-prompt-compilation.ts:279-284) į kompaktų vienos-dviejų eilučių sąrašą, apimantį visus render.ts naudojamus markerius.
- [ ] coder (jei būtina): sinchronizuoti legendos šaltinį su `compact-dsl/render.ts` markerių apibrėžimu, kad jie negalėtų tyliai išsiskirti.
- [ ] tester: parašyti/papildyti `src/tests/**` testą, matuojantį preambulės+fence pridėtinę kainą (`compiledChars − document chars`) ant realaus korpuso, `<= 250` ženklų abiem režimams.
- [ ] tester: patvirtinti, kad esamas compact-dsl round-trip decode testas ir IR JSON schema testas praeina nepaliesti; atnaujinti bet kokius fixture'ais paremtus dydžio testus su teisingomis naujomis reikšmėmis (ne susilpninti).
- [ ] reviewer: patikrinti, kad `guardCompiledWorkerPromptSize`, `compressionSizeFallbackReason` ir viešos funkcijų signatūros liko nepaliestos; patikrinti sluoksnių ribas ir failo dydžio limitą (≤500 eilučių).
- [ ] visi: paleisti `pnpm typecheck && pnpm test`, patvirtinti žalius rezultatus prieš commit.
- [ ] commit su nukrypimo/pakeitimo aprašu, jei sutrumpinimas atskleidžia bet kokį anksčiau nepastebėtą etalono elgesio skirtumą.

## AG Queue Tasks
- 031-kompiliuoto-kuno-preambule-moka-uz-save.md (jau egzistuoja `AG/tasks/queue/`) — šis OpenSpec change yra jo pilna specifikacija; papildomo queue task'o kurti nereikia.
- depends_on: 030-ir-nebe-nesa-sekciju-dvigubai-strukturine-parse-apreptis.md turi būti uždarytas PRIEŠ šio change'o implementaciją.
