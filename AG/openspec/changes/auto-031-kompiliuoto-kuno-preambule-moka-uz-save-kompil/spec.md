# Spec Delta

## Added
- Naujas (arba papildytas esamas) testas `src/tests/**`, kuris ant realaus/reprezentatyvaus korpuso patikrina, kad abiejų renderių (`worker_task_ir`, `compact_dsl`) fiksuota preambulės+fence pridėtinė kaina (`compiledChars − document.length`) yra `<= 250` ženklų kiekvienam korpuso task'ui.
- (Jei įgyvendinama per bendrą konstantą) vienas šaltinis DSL markerių legendai, naudojamas tiek `renderCompactWorkerDslPrompt`, tiek galimai `compact-dsl/render.ts` markerių apibrėžime, kad legenda negalėtų tyliai išsiskirti nuo realių markerių.

## Changed
- `renderWorkerTaskIrPrompt` (`src/application/context-pack/worker-prompt-compilation.ts`): preambulė sutrumpinta iki minimalaus vienareikšmio teksto; antraštės eilutė, task_id/sha eilutė ir fence struktūra nesikeičia.
- `renderCompactWorkerDslPrompt` (`src/application/context-pack/worker-prompt-compilation.ts`): markerių legenda glaudinama iš ~6 eilučių prozos į kompaktų vienos-dviejų eilučių `marker=reikšmė` sąrašą; antraštės eilutė, task_id/sha eilutė ir fence struktūra nesikeičia.
- Galimai `src/application/context-pack/compact-dsl/**`: TIK jei būtina, kad legendos šaltinis sutaptų su render'io naudojamais markerių pavadinimais (pvz. eksportuojama bendra markerių-aprašymų konstanta). Pačių markerių reikšmių ar DSL sintaksės keisti NEREIKIA.
- Esami testai, kurie fiksuoja konkrečius `compiledChars`/preambulės tekstą kaip fixture (jei tokių yra `src/tests/**`), atnaujinami su naujomis, teisingomis reikšmėmis — ne susilpninami.

## Acceptance Criteria
- AC1: Abiejų renderių (`worker_task_ir`, `compact_dsl`) preambulės+fence fiksuota pridėtinė kaina realiame korpuso teste yra `<= 250` ženklų kiekvienam patikrintam task'ui.
- AC2: Esamas `compact-dsl` decode-atgal-į-IR (round-trip) testas praeina nepakeistas ir be jokio susilpninimo — sutrumpinta legenda neįtakoja paties dokumento formato ar jo dekodavimo.
- AC3: IR pusės JSON schema validacija (jei yra atskiras testas ant `WorkerTaskIr` struktūros) lieka nepaliesta — keičiasi tik prompt'o prozos tekstas aplink JSON fence'ą, ne pats JSON turinys.
- AC4: `guardCompiledWorkerPromptSize` funkcijos kodas (`>=` palyginimas, fallback tipai `COMPRESSION_FALLBACK_SIZE`/`COMPRESSION_FALLBACK_RAW`, `compressionSizeFallbackReason`) lieka be jokių pakeitimų — testu patvirtinama, kad funkcijos signatūra ir elgesys identiški prieš/po.
- AC5: `pnpm typecheck && pnpm test` žali po pakeitimo, įskaitant lint pakopą.
- AC6: Nė vienas markeris, kurį naudoja `compact-dsl/render.ts` išvestis (T, H, G, E, X, A, V, S, R, N, O, `RAW#<h>.<n>`, `{F}` alias, `<MARKER>#<n>`), neišnyksta iš sutrumpintos legendos — sutrumpinama žodyno ilgis, ne markerių sąrašo pilnumas.
- AC7: Visi failai keičiami lieka `≤ 500` eilučių (architecture-gates.test.ts vartas) ir importų grafas lieka aciklinis be naujų sluoksnių ribų pažeidimų.

## AG Queue Tasks
- Šis change'as ATITINKA jau egzistuojantį task'ą `AG/tasks/queue/031-kompiliuoto-kuno-preambule-moka-uz-save.md` — naujos eilės užduoties kurti nereikia, šis OpenSpec change yra jo specifikacija.
