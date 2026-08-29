# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Po to, kai `finalizeDispatch` pradėjo rašyti `worker_prompt_chars` į `context-size.jsonl`, `src/application/context-pack/metrics.ts:72–77` komentaras „declared for schema/reader compatibility, no writer in this module" tapo melagingas: rašytojas egzistuoja, tik gyvena dispatch finalize pusėje. Atnaujinti komentarą ir testu įrodyti, kad tokios formos įrašas praeina `joinPostRunTruth` gate'ą (nebe tuščias rezultatas).

## Agentai
PRIVALOMA grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/metrics.ts`
- `src/tests/context-pack-metrics.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `src/infrastructure/adapters/claude-dispatch-finalize.ts`
- `src/application/analytics/post-run-truth-join.ts`
- `src/application/context-pack/context-cache-key.ts`

## Veiksmas
- `workerPromptChars` JSDoc'e pakeisti „no writer in this module" į tikslų faktą: assembly-time matavimas jo neturi, rašytojas yra dispatch finalize (`claude-dispatch-finalize.ts`), kuris naudoja realų išsiųsto prompt'o ilgį.
- Teste patikrinti, kad `buildContextSizeMetrics` su `workerPromptChars` + `rawTaskChars` + `attempt`/`attempt_id` grąžina įrašą su `worker_prompt_chars` ir `raw_task_chars` laukais.
- Tuo pačiu įrašu patikrinti, kad `joinPostRunTruth` su atitinkančiu token-usage įrašu grąžina nebe tuščią rezultatą, o `compiled_chars` lygu `worker_prompt_chars`.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei komentaro tikslinimas reikalautų keisti pačių laukų semantiką ar `COMPRESSION_METRIC_FIELDS` lentelę — tai jau kontrakto keitimas, ne dokumentacija.

## Neįtraukta
`CONTEXT_CACHE_VERSION` kėlimas — pack turinys nesikeičia. `post-run-truth-join.ts` komentaro (eil. 127–131) taisymas — skaitymo pusės failas šioje užduotyje draudžiamas; jei jo tekstas irgi pasenęs, įrašyk tai į ataskaitos rizikas, netaisyk tyliai. `symbol_slices` shadow pora — task 087.
