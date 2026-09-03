# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
`vq/logs/context-size.jsonl` turi dvi eilučių rūšis: pack'o eilutes (neša `canary_features` ir tikrą biudžetą) ir sintetines eilutes, kurios pack'o neaprašo (finalize `worker_prompt_chars`, tool-schema shadow, hook digest — visi eksplicitiškai rašo `max_context_chars: 0` ir be `canary_features`). Skaitytojai taiko „vėliausias laimi", tad sintetinė eilutė demotuoja canary į control. Šis darbas duoda vieną bendrą predikatą, kuriuo skaitytojai atskirs pack'o įrašą; patys skaitytojai taisomi atskirose užduotyse.

## Agentai
PRIVALOMA grandinė šia tvarka: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/context-pack/metrics.ts`
- `src/tests/context-pack-metrics.test.ts`

Draudžiama:
- `src/application/analytics/attempt-identity-join.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts`
- `src/infrastructure/adapters/claude-dispatch-finalize.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `metrics.ts`: eksportuok vieną predikatą `describesContextPack(record: Partial<ContextSizeMetricsRecord>): boolean` šalia `ContextSizeMetricsRecord` (196 eil.); architektas patvirtina kriterijų `max_context_chars > 0` arba pasiūlo ekvivalentų (`cache_status !== "unknown"`).
- JSDoc'e įvardyk tris sintetinius rašytojus (finalize `worker_prompt_chars`, `dispatch_tool_schema` shadow, hook digest) ir kodėl jų eilutės nėra arm'o įrodymas; komentare NENAUDOK `*/` sekos.
- `context-pack-metrics.test.ts`: ribiniai atvejai — `max_context_chars: 0` (ne pack'as), teigiamas biudžetas (pack'as), trūkstamas laukas (ne pack'as, nes senas pack'o įrašas biudžetą visada turi).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei rasi gyvą pack'o rašytoją, kuris gali rašyti `max_context_chars: 0` — tada predikatas turi būti kitas, o rašytojas netaisomas.

## Neįtraukta
- `attempt-identity-join.ts` / `compression-cohorts.ts` / `cohort-model.ts` predikato pritaikymas — kita eilės užduotis.
- `worker-prompt-preparation.ts` vėliausio įrašo žemėlapis — kita eilės užduotis.
- Rašytojų (`claude-dispatch-finalize.ts`) keitimas — sąmoningai atmesta alternatyva.
