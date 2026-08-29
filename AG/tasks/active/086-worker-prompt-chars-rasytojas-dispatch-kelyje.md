# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei grep `worker_prompt_chars`/`workerPromptChars` randa rašytoją dispatch
kelyje — t. y. `src/interfaces/cli/dispatch/claude-dispatch/command.ts`,
`dispatch-prelaunch.ts` arba
`src/infrastructure/adapters/claude-dispatch-finalize.ts` paduoda
`workerPromptChars` į `buildContextSizeMetrics`/`appendContextSizeMetrics`
kelią, o `src/application/context-pack/metrics.ts` komentaras „no writer in
this module" atnaujintas — ALREADY_IMPLEMENTED: cituoti rašytojo eilutes.

## Tikslas
2026-08-29 kompresijos posistemio auditas:
`src/application/context-pack/metrics.ts:72–77` deklaruoja
`workerPromptChars` su komentaru „declared for schema/reader compatibility,
no writer in this module" — laukas neturi JOKIO rašytojo visame src. Dėl to
`src/application/analytics/post-run-truth-join.ts:146` (`joinPostRunTruth`
gate'ina `worker_prompt_chars === undefined` → continue) VISADA grąžina 0
eilučių, o `findTokenizerUnfriendlySignals`
(`src/application/analytics/tokenizer-unfriendly-signal.ts`) niekada
negauna įvesties — task 0042 signalai miega.

Realus išsiųsto prompt'o dydis dispatch metu ŽINOMAS:
`command.ts:217` (`const workerPrompt = canonicalPrompt.prompt`) ir
`dispatch-prelaunch.ts:55` jau loguoja
`prompt_chars: ${input.workerPrompt.length}` į žmogui skirtą audito įrašą —
trūksta tik įrašo į `context-size.jsonl`. Dispatch pusės rašytojo šablonas
jau egzistuoja: `claude-dispatch-finalize.ts:144–160` shadow porą rašo per
`buildContextSizeMetrics` + `appendContextSizeMetrics` best-effort režimu
(gedimas nelaužo finalize). Laukų lentelė `COMPRESSION_METRIC_FIELDS`
(`metrics.ts:137`) porą `["workerPromptChars", "worker_prompt_chars"]` jau
turi — rašytojo tik nėra.

Sprendimo kryptis: dispatch'as po galutinio prompt'o surinkimo įrašo
`worker_prompt_chars` (kartu su `raw_task_chars`, kurio reikalauja
join'as). Ar tai daro prelaunch, ar finalize, ir ar per esamą shadow
append, ar atskirą įrašą — architect sprendimas šio task'o viduje.
SVARBU: keičiama TIK telemetrija — pack'o turinys neliečiamas, tad
`CONTEXT_CACHE_VERSION` NEKELIAMAS (žr. Neįtraukta).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/command.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-prelaunch.ts`
- `src/infrastructure/adapters/claude-dispatch-finalize.ts`
- `src/application/context-pack/metrics.ts` (komentaro „no writer"
  atnaujinimas; laukai jau deklaruoti)
- `src/composition/agent/dispatch-adapters.ts` (surišimas, jei rašytojui
  reikia porto)
- `src/tests/interfaces-cli-dispatch-command.test.ts`
- `src/tests/context-pack-metrics.test.ts`
- `src/tests/infrastructure-dispatch-flow.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `src/application/context-pack/assemble/**` (pack'o surinkimas — turinys
  neliečiamas; assemble scope yra task 087)
- `src/application/analytics/post-run-truth-join.ts` (skaitymo pusė jau
  teisinga — laukia tik duomenų)
- `src/application/context-pack/context-cache-key.ts`
  (`CONTEXT_CACHE_VERSION` nekeliamas — pack turinys nesikeičia)

## Veiksmas
- Architect: parinkti rašymo tašką (prelaunch po `workerPrompt`
  išsprendimo ar finalize šalia esamo shadow append) ir įrašo formą —
  `worker_prompt_chars` + `raw_task_chars` (+ `attempt`/`attempt_id`, jei
  join'ui reikalingi — žr. `post-run-truth-join.ts:23` laukų sąrašą).
- Coder: įrašyti rašytoją pasirinktame taške per esamą
  `buildContextSizeMetrics`/`appendContextSizeMetrics` kelią best-effort
  režimu (telemetrijos gedimas nelaužo dispatch'o); atnaujinti
  `metrics.ts` „no writer" komentarą.
- Testų lūkestis: po dispatch'o `context-size.jsonl` turi įrašą su
  `worker_prompt_chars`, lygų realiam išsiųsto prompt'o ilgiui;
  `joinPostRunTruth` su tokiu įrašu grąžina nebe tuščią rezultatą;
  telemetrijos rašymo klaida nenutraukia dispatch'o.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei pasirodytų, kad
teisingas rašymo taškas gyvena už deklaruotų failų (pvz.
`dispatch-invocation.ts`) — pridėti kelią tik su ataskaitos įrašu, ne
tyliai.

## Neįtraukta
`CONTEXT_CACHE_VERSION` kėlimas — SĄMONINGAI ne: keičiama tik telemetrija
(context-size.jsonl įrašas), pack'o turinys ir jo kešo raktas nesikeičia.
Skaitymo pusė (`post-run-truth-join.ts`, `tokenizer-unfriendly-signal.ts`)
— jau veikia, laukia tik duomenų. `symbol_slices` shadow poros matavimas —
task 087 (nepriklausomas).
