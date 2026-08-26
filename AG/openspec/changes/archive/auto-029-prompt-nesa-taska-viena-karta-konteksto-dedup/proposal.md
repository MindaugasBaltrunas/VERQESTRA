# Proposal

## Why
`buildWorkerPrompt` (`src/application/task-execution/execution-context-gate.ts:265-291`) šiuo metu paduoda workeriui du kopijas to paties task'o: (1) pilną kūną (`taskText` arba `compiledTask`) ir (2) pridedamą `execution context`, kurio `## Goal`, `## Acceptance criteria`, `## Allowed paths`, `## Checks`, `## Out of scope` blokai (`render-candidates.ts:41-79` ir `:260-267`) yra tie patys laukai, atrinkti iš TO PATIES task failo per `ContextPack.goal / acceptance_criteria / allowed_paths / checks / out_of_scope`. `worker-prompt-compilation.ts` antraštė šią problemą jau vadina „the SAME task twice", bet 0025 kompresija ją išsprendė tik kūno pusėje (raw → IR/DSL) — kontekstinės kopijos liko. Auditas 2026-08-26 (53 realūs task failai) nustatė, kad kompresijos ROI negali atsipirkti kūno lygyje, nes sutaupymas gyvena šitame dubliavime.

## Scope
- `src/application/task-execution/execution-context-gate.ts` — `resolveCanonicalWorkerPrompt` prompt'ą surenka su deduplikuotu (task-derived elementų neturinčiu) execution context variantu, kai `contextPackText` yra ir jį galima perskaityti pagal `contextPackSchema`.
- `src/application/context-pack/render-candidates.ts` — kandidatai, kurių turinys pilnai kyla iš task failo (`goal`, `acceptance-criteria`, `allowed-paths`, `checks`, `out-of-scope`), pažymimi kaip task-derived, kad juos būtų galima atrinkti be antraštės (title) string sutapatinimo.
- `src/application/context-pack/render-execution-context.ts` — `renderExecutionContext` gauna naują, numatytai IŠJUNGTĄ parinktį atrinkti task-derived kandidatus prieš biudžeto metimo ciklą; be šios parinkties (esamas iškvietimas diskui) elgesys ir baitai NESIKEIČIA.
- `src/application/context-pack/worker-prompt-compilation.ts` — tik antraštės komentaro atnaujinimas (nukrypimo nuo etalono įvardijimas), be funkcinio kodo pakeitimo.
- Testai po `src/tests/**`.

## Out Of Scope
- IR (WorkerTaskIR/compact DSL) vidinio dubliavimo taisymas — task 030.
- Preambulės (fiksuoto skaitymo rakto) mažinimas compiled promptuose — task 031.
- Shadow matavimo poros keitimas — task 032.
- UI pakeitimai.
- `execution-context.md` disko artefakto turinio ar `CONTEXT_CACHE_VERSION` kėlimas — šis change'as jį palieka baitas-į-baitą tapatų esamiems iškvietimams.

## Architecture Boundaries
- Modulis: `application/context-pack` + `application/task-execution` (application sluoksnis; leidžiama importuoti application, domain, shared — jokio infrastructure/interfaces ryšio nekuriama, `contextPackSchema` importas jau egzistuoja `execution-context-gate.ts` faile).
- Reads DB schemas: nėra (grynos funkcijos; `contextPackText` jau ateina kaip parametras, jokio naujo IO).
- Writes DB schemas: nėra.
- Job types: nėra (esami dispatch iškvietimo taškai `infrastructure/adapters/adapter-dispatch.ts` ir `interfaces/cli/dispatch/claude-dispatch/command.ts` naudoja TIK `resolveCanonicalWorkerPrompt` ir `isSourceChangeDispatch`; jų nereikia liesti — dedup lieka pilnai uždaras leidžiamų failų viduje).
