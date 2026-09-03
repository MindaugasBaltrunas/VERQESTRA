# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 154-kohortu-arm-as-skaitomas-tik-is-pack-o-irasu-finalize-nedemotuoja

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/context-pack/assemble/persist.ts` nebeimportuoja
`compact-dsl/render.js`, `worker-task-ir.js`, `worker-task-ir-schema.js` ir
`compileWorkerPromptTask`, o `src/application/context-pack/assemble/assemble.ts` nebeturi
`compileWorkerPromptTaskForDispatch` kvietimo (size-guard prognozė, ~119-123 eil.) —
ALREADY_IMPLEMENTED: cituok abiejų failų importų blokus ir `persist` įėjimo tipą be
`canarySizeFallback`.

## Tikslas
Auditas `docs/audits/compression-audit-2026-09-03.md` §1: shadow pora
`raw_prompt_chars`/`compiled_prompt_chars` per 204 iš 204 matavimų rodo, kad `compact_dsl` ir
`worker_task_ir` kompiliuotas prompt'as yra DIDESNIS už žalią (+3,4 % … +15,4 %). Abi feature'ės
konfige `false`; klausimas uždarytas duomenimis. Tačiau kiekvienas dispatch'as VIS DAR
kompiliuoja du kartus: `persist.ts:109-119` (shadow IR + DSL renderis), `persist.ts:147-161`
(shadow kompiliuoto prompt'o dydis) ir `assemble.ts:119-123` (size-guard prognozė
`compileWorkerPromptTaskForDispatch`, kurios vienintelis vartotojas — `canarySizeFallback`
žymė telemetrijai). Tai grynas CPU ir kodo svoris už atsakymą, kuris jau žinomas.

Šis task'as yra PIRMAS iš keturių `compact_dsl`/`worker_task_ir` išėmimo žingsnių — vienintelis,
kuris savarankiškai žalias be modulių trynimo: išjungia shadow kompiliaciją ir prognozę
rašytojo pusėje, palieka skaitytojus tolerantiškus seniems žurnalams. Registro/konfigo
retyrimas, dispatch kelio raw-only ir modulių tombstone'ai — vėlesni task'ai (žr. Neįtraukta),
nes jų `## Failai` priklauso nuo to, kurie eksportai po šio task'o liks be kvietėjų.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai

> 2026-09-03 19:18 parkas: `changed files outside allowed paths: src/tests/context-pack-assemble.test.ts`.
> Autorystės klaida: tas testas tvirtino `result.workerTaskIr` (93 eil.) — shadow IR lauką,
> kurį šis task'as ir šalina. Grep'inau `canarySizeFallback|compiledPromptChars|shadow*`,
> bet ne `workerTaskIr`. Vykdytojo darbas (šaka
> `ag/worker/60af1d0f-…/155-compact-dsl-ir-worker-task--d9a23276/a1`, commit 965999a4, 9 failų,
> +151/−267) yra tiksliai pagal `## Veiksmas` ir žalias; vienintelis pakeitimas už ribos —
> viena pašalinta assert eilutė. Kelias pridedamas žemiau; darbas suliejamas, ne perdirbamas.

Leidžiama:
- `src/tests/context-pack-assemble.test.ts` (93 eil. `result.workerTaskIr` assert'as — laukas šalinamas)
- `src/application/context-pack/assemble/persist.ts`
- `src/application/context-pack/assemble/assemble.ts`
- `src/application/context-pack/metrics.ts` (builder'io įėjimas; skaitytojo tipas lieka)
- `src/application/context-pack/worker-prompt-compilation.ts` (tik `COMPRESSION_FALLBACK_SIZE` eksporto matomumas)
- `src/tests/context-pack.test.ts`
- `src/tests/context-pack-metrics.test.ts`
- `src/tests/characterization-compact-dsl.test.ts` (persist įėjimas 182 ir 214 eil.; parity fixture NEKEIČIAMA)
- `src/tests/context-pack-guards.test.ts` (pina `CONTEXT_CACHE_VERSION` — liečiamas TIK jei pack'o turinys keistųsi)

Draudžiama:
- `src/application/context-pack/compact-dsl/model.ts`
- `src/application/context-pack/compact-dsl/parse.ts`
- `src/application/context-pack/compact-dsl/parity.ts`
- `src/application/context-pack/compact-dsl/render.ts`
- `src/application/context-pack/worker-task-ir.ts`
- `src/application/context-pack/worker-task-ir-schema.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts` (dispatch kelias — 2-as žingsnis)
- `src/domain/policies/compression/features.ts` (registras — 2-as žingsnis)
- `src/tests/fixtures/characterization/compression-policy-verdicts.json`
- `src/tests/fixtures/characterization/worker-task-ir.json`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `persist.ts`: pašalinti `shadowCompileWorkerTaskIr`, `shadowRenderCompactWorkerDsl`,
  `shadowCompiledPromptBody`, `SHADOW_COMPRESSED_PROMPT_CONFIG` ir jų importus (17, 34-36 eil.);
  telemetrijoje nebeteikiami `compiledTaskChars`/`irJsonChars`/`dslIrChars`/`dslCompiledChars`/
  `compiledPromptChars`; `rawPromptChars`, simbolių pora ir visi kiti laukai lieka nepakitę.
  Persist įėjimas netenka `canarySizeFallback`.
- `assemble.ts`: pašalinti size-guard prognozę (119-123 eil.) ir `canarySizeFallback` perdavimą
  (168, 446 eil.) su importu (40 eil.). `size-fallback` markeris nebegimsta — feature'ės, kurioms
  jis egzistavo, išjungtos; `CANARY_SIZE_FALLBACK_MARKER` skaitytojuose LIEKA (seni įrašai).
- `metrics.ts`: `buildContextSizeMetrics` įėjimas netenka `canarySizeFallback` ir compiled/dsl
  laukų; `ContextSizeMetricsRecord` ir `readContextSizeMetrics` juos TOLERUOJA toliau —
  `vq/logs/context-size.jsonl` turi 204 istorinius įrašus su šia pora, o UI juos rodo.
- `worker-prompt-compilation.ts`: `COMPRESSION_FALLBACK_SIZE` po `assemble.ts` pakeitimo netenka
  išorinio kvietėjo — palikti modulio konstanta be `export` (dead-export vartas), tipas
  `CompressionFallbackLabel` nekinta.
- Pack'o turinys NESIKEIČIA (shadow niekada nebuvo pack'e) — `CONTEXT_CACHE_VERSION` nekeliama;
  jei architektas rastų priešingai, kelti ir pataisyti pin'ą `context-pack-guards.test.ts`.
- Testai: `context-pack.test.ts` (126-153 eil. kompiliavimo testai lieka — `compileWorkerPromptTask`
  tebeeksportuojamas; 450 eil. persist įėjimas be `canarySizeFallback`; `COMPRESSION_FALLBACK_SIZE`
  importas 14 eil. keičiamas literalu `"size"` arba per `compileWorkerPromptTaskForDispatch`
  grąžinamą reikšmę), `context-pack-metrics.test.ts` (visi `canarySizeFallback: false` įėjimai;
  143 eil. shadow testas pertvarkomas į „builder'is compiled laukų nebepriima, skaitytojas seną
  įrašą su jais tebeparsina"), `characterization-compact-dsl.test.ts` (182, 214 eil. — tik persist
  įėjimas; SHA256 parity tvirtinimai lieka baitas-į-baitą).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad `compiled_prompt_chars` porą
skaito kas nors, kas be jos griūva (ne rodo „unmeasured", o meta) — tada skaitytojas taisomas
atskiru task'u prieš šį.

## Neįtraukta
- 2-as žingsnis: `features.ts` registras netenka `compact_dsl`/`worker_task_ir` su legacy raktų
  tolerancija parser'yje (gyvas `vq/config/context-compression.json` juos turi — griežtas
  parser'is nuverstų loop'ą ENVIRONMENT klaida), `dependencies.ts`, `arrest.ts` skaitikliai,
  `worker-prompt-preparation.ts` + `worker-prompt-compilation.ts` raw-only, fixture
  `compression-policy-verdicts.json`, `templates/vq/config/context-compression.json`.
- 3-ias žingsnis: `compact-dsl/*`, `worker-task-ir*.ts`, jų 4 testai ir 2 fixture'ai —
  tombstone'ai + operatoriaus `rm` sąrašas (sandbox failų netrina); NUKRYPIMAS nuo etalono
  rašomas į tris vietas (commit ataskaita, etalono `tasks.md`, `migration-coverage.json`).
- 4-as žingsnis: `ui-compression-view.ts`, `CompressionPage.tsx`, `types.ts`, `I18nContext.tsx`
  — compact_dsl eilučių išėmimas ir `symbol_slices` pervadinimas į praturtinimą.
- `dispatch_tool_schema` ir `bash_output_digest` shadow poros — auditas 2 #152, atskirai.
