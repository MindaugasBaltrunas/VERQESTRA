# Proposal

## Why
- `persist.ts:91-92` skaičiuoja shadow porą `workerTaskIrChars(ir)` (JSON IR dydis) vs `input.taskText.length` (žaliavinis task kūnas). `ui-compression-view.ts` naudoja tuos pačius laukus (`raw_task_chars`/`compiled_task_chars`) verdiktui skaičiuoti.
- Nei viena pusė šios poros nėra tai, ką worker'is realiai gauna: reali kaina yra pilnas prompt'as — task kūnas (žalias arba sukompiliuotas DSL/IR tekstas, ne JSON) PLIUS execution-context.md, kurį dispatch prisega prie kiekvieno kvietimo (žr. `worker-prompt-preparation.ts:99-103`, kur `sent_prompt_chars=compression.task.compiledChars`, o execution context pridedamas atskirai per `executionContextPath`).
- 2026-08-26 audito radinys: pilno prompt'o lygyje IR variantas yra +54% didesnis už raw, kūno lygyje — tik +27%. Dabartinis `ir_json_chars` vs `raw_task_chars` matavimas neaprėpia nei execution context'o, nei DSL kompiliavimo pridėtinio teksto, tad sistemingai nuvertina realią kainą, ir dabartinis verdiktas (`decideCompression`) gali rekomenduoti „enable", kai reali dispatch grandinė prompt'ą augintų.
- 029 (dedup) pakeitė tai, kas patenka į execution context vieną kartą vietoj daug kartų — teisingas matavimo taškas atsiranda tik PO 029, ne prieš jį.

## Scope
- `src/application/context-pack/metrics.ts`: nauji NEPRIVALOMI `ContextCompressionMetricsInput`/`ContextCompressionMetrics` laukai prompt'o lygio žalio ir sukompiliuoto dydžio porai (su tuo pačiu execution context'u).
- `src/application/context-pack/assemble/persist.ts`: naujos poros apskaičiavimas panaudojant TĄ PATĮ jau surenderintą `executionContextBody`/`rendered.markdown`, kurį šis pats kvietimas rašo į `executionContextPath` (jokio antro render'io).
- `src/interfaces/http/ui-compression-view.ts`: `decideCompression` persijungia prie naujos poros, kai ji mėginiuose yra; UI sakiniai ir priežasčių kodai atnaujinami įvardyti, KAS lyginama.
- `ui-app/src/**`: tik verdikto šaltinio laukų ir vertimų atnaujinimas atitinkamai naujiems priežasčių kodams.
- Testai naujiems laukams `metrics.ts`, `persist.ts`, `ui-compression-view.ts`.

## Out Of Scope
- Dedup logika (029) — šis task'as bėga PO jos, jos nekeičia.
- IR/preambulės turinio keitimai (030, 031).
- Benchmark paketo kompresijos kohortos (`AG/benchmark`).
- Slenksčio konstantos (`MIN_DECISION_SAMPLES`, spaudimo lygiai) — nesikeičia.
- Senų laukų (`raw_task_chars`, `ir_json_chars`, `compiled_task_chars`) pašalinimas — jie lieka rašomi visada.

## Architecture Boundaries
- Moduliai: `application/context-pack` (`metrics.ts`, `assemble/persist.ts`) ir `interfaces/http` (`ui-compression-view.ts`) plius `ui-app` (verdikto vaizdas). Sluoksnių riba nekeičiama: `interfaces` toliau negauna jokio naujo `infrastructure` importo, `application` toliau nesikreipia į `interfaces`.
- Reads: `vq/logs/context-size.jsonl` (per `ContextPackFileSystemPort`/`readContextSizeLog` portą, ne tiesioginis FS).
- Writes: `vq/logs/context-size.jsonl` (papildomi NEPRIVALOMI laukai kiekvienam naujam įrašui; senos eilutės nekeičiamos).
- Job types: nėra (telemetrijos/metrikos pakeitimas, joks naujas worker/job tipas nekuriamas).
