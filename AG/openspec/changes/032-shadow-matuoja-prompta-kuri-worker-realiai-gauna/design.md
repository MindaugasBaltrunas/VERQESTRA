# Design

## Approach

1. **Nauji lauko vardai, ne pakartotinis `worker_prompt_chars`.** Šis laukas jau
   deklaruotas `ContextCompressionMetricsInput`/`Record` (`metrics.ts:71-77`) su aiškiu
   komentaru: „no writer in this module" — jis rezervuotas REALIAM dispatch'o prompt'o
   dydžiui, kurį vėliau įrašys interfaces/dispatch sluoksnis, ir kurį jau skaito
   `post-run-truth-join.ts` kaip `compiled_chars`. Shadow spėjimas iš assembly meto NĖRA
   tas pats matavimas (jis neįtraukia gate refuse/skip realaus lauko, retry pertvarkymų
   ir t.t.), tad jam reikia atskirų laukų:
   - `promptCharsRawShadow` / `prompt_chars_raw_shadow` — raw task kūnas + execution
     context, joks iš jų nekompiliuotas.
   - `promptCharsCompiledShadow` / `prompt_chars_compiled_shadow` — kompiliuotas
     (WorkerTaskIR arba esamas compiled task tekstas) kūnas + TAS PATS execution
     context.
   Abu — NEPRIVALOMI, laikantis esamos taisyklės „nesantis matavimas yra NESANTIS, ne 0"
   (`metrics.ts:56-60`). Senieji `raw_task_chars`/`ir_json_chars`/`compiled_task_chars`
   lieka rašomi nepakitę — joks esamas skaitytojas nelūžta.

2. **Vienas kelias, ne kopija.** `persist.ts` jau turi abu gabalus, reikalingus prompt'o
   sąrangai:
   - `input.taskText` — raw kūnas;
   - `rendered.markdown` (iš `renderExecutionContext(pack, ...)`, `persist.ts:154`) —
     TAS PATS execution context, kuris įrašomas kaip `execution-context.md` ir kurį
     realus dispatch'as prijungtų.
   Vietoje savo sujungimo formulės (`kūnas + "\n" + context`, su savavališku separatoriumi),
   shadow apskaičiavimas privalo kviesti TĄ PAČIĄ funkciją, kuri sulipdo canonical worker
   prompt'ą realiam dispatch'ui — `resolveCanonicalWorkerPrompt` arba jos vidinį
   sujungimo žingsnį (`application/task-execution/execution-context-gate.ts`). Kviečiama
   DU kartus tuo pačiu `executionContext` argumentu: kartą su `compiledTask` (IR arba
   compiled task tekstas, jei yra), kartą be jo (priverstinis raw kelias). Abu kvietimai
   naudoja tą patį `mode`/`sourceChange` sprendimą, koks būtų realiam šio task'o
   dispatch'ui.
   `execution-context-gate.ts` nėra `## Failai / Leidžiama` sąraše — jis TIK
   importuojamas skaitymui iš `persist.ts`/`metrics.ts`, nekeičiamas.

3. **Gate rezultatas gali būti `refuse`/`skip`, ne tik `attach`.** Jei
   `resolveCanonicalWorkerPrompt` šiam task'ui grąžintų `refuse` arba `skip` (pvz. stale
   source slices, execution context mode išjungtas), shadow prompt'o pora lieka
   NEAPSKAIČIUOTA (abu laukai absent), ne apskaičiuota su tuščiu/klaidingu context'u.
   Persist.ts assembly metu neturi IO patikros, kurią command.ts atlieka prieš dispatch'ą
   (`staleSourceSlicesFor` prieš gate kvietimą, `command.ts:114-116`) — jei šios patikros
   trūkumas keistų gate sprendimą kitaip nei realiame dispatch'e, shadow pora TURI likti
   absent su aiškiu komentaru, o ne tyliai spėti „unchecked".

4. **UI verdiktas persijungia laipsniškai.** `summarizeContextSizeSamples` skaičiuoja
   naują poros: `prompt_compared_count`, `prompt_smaller_count`,
   `avg_prompt_delta_percent` — analogiškai esamai `ir_compared_count`/`ir_smaller_count`/
   `avg_ir_delta_percent`, bet iš naujų laukų. `decideCompression`'s `worker_task_ir`
   rekomendacija naudoja prompt'o porą, kai `prompt_compared_count >= MIN_DECISION_SAMPLES`;
   priešingu atveju — esamą kūno lygio logiką nepakitusią (fallback, ne lūžis, kol
   mėginių dar nesusikaupė po deploy'aus).
   UI sakiniai (`ui-app/src/**`) atnaujinami įvardyti: „lyginamas PILNAS prompt'as
   (kūnas + kontekstas)", o ne palikti įspūdį, kad tebelyginamas vien IR kūnas.

## Data Flow

```
persist.ts (assembly, cache hit ARBA miss)
  ├─ input.taskText                         (raw kūnas)
  ├─ workerTaskIr = shadowCompileWorkerTaskIr(...)   [jau yra]
  ├─ rendered = renderExecutionContext(pack, ...)    [jau yra — VIENAS render'is]
  │
  ├─ shadow raw prompt    = resolveCanonicalWorkerPrompt({ taskText, executionContext: rendered.markdown, ...bendra būsena, compiledTask: undefined })
  ├─ shadow compiled prompt = resolveCanonicalWorkerPrompt({ taskText, executionContext: rendered.markdown, ...ta pati būsena, compiledTask: <IR/compiled tekstas> })
  │     (abi absent, jei gate refuse/skip arba workerTaskIr nėra)
  │
  └─ appendContextSizeMetrics(...) 
        prompt_chars_raw_shadow      = shadow raw prompt.length      [jei apskaičiuota]
        prompt_chars_compiled_shadow = shadow compiled prompt.length [jei apskaičiuota]
        (+ esami raw_task_chars/ir_json_chars/compiled_task_chars nepakitę)
             │
             ▼
     vq/logs/context-size.jsonl (append)
             │
             ▼
ui-compression-view.ts: buildCompressionView
  ├─ summarizeContextSizeSamples  → { prompt_compared_count, prompt_smaller_count, avg_prompt_delta_percent, ...esami IR laukai }
  └─ decideCompression            → naudoja prompt'o porą, jei jos pakanka; kitaip esamą IR porą
             │
             ▼
     ui-app: kompresijos vėliavų puslapis (verdikto sakiniai atnaujinti)
```

## Risks

- **Antra render'io kopija su kitokia semantika.** Jei paaiškės, kad
  `resolveCanonicalWorkerPrompt` reikalauja IO priklausomybių (stale source slices
  patikros), kurių `persist.ts` assembly metu tiesiog neturi, ir kurių nebuvimas keistų
  gate sprendimą — tai TIKSLIAI task'o Stop sąlyga. Implementacija privalo STOTI ir
  eskaluoti (pasiūlyti architect'ui), o NE parašyti antrą sujungimo formulę su
  „unchecked" ar kitokia užsklanda. Rizika žema (persist.ts jau turi visus ne-IO
  gabalus), bet turi būti patikrinta PRIEŠ kodavimą, ne po.
- **Lauko pavadinimų kolizija.** Yra pagunda naudoti jau deklaruotą `worker_prompt_chars`
  shadow reikšmei — tai pakartotų BŪTENT tą klaidą, dėl kurios šis task'as egzistuoja
  (0032 pastaba: du logai matavo du skirtingus dalykus tuo pačiu vardu). Nauji, aiškiai
  pavadinti (su `_shadow` sufiksu) laukai yra privalomi, ne stiliaus pasirinkimas.
- **`post-run-truth-join.ts` neturi būti paliestas.** Jis jau filtruoja įrašus be
  `worker_prompt_chars` (`post-run-truth-join.ts:127-134`) — šis task'as prie to lauko
  NEPRISIDEDA, tad joks join'o elgesys nesikeičia. Jei implementacija pagunda „užpildyti"
  `worker_prompt_chars` shadow reikšme, kad join'as pradėtų veikti anksčiau — tai
  klaidinga: join'as laukia REALAUS dispatch'o matavimo, ne shadow spėjimo.
- **UI verdikto lūžis mažai turintiems mėginių aplinkoms.** Fallback į IR-poros logiką,
  kai `prompt_compared_count < MIN_DECISION_SAMPLES`, būtinas, kad esami operatoriai su
  senais `context-size.jsonl` įrašais (be naujų laukų) matytų TĄ PATĮ verdiktą kaip
  šiandien, o ne staiga „insufficient".
- **Legacy JSONL suderinamumas.** Nauji laukai — NEPRIVALOMI abiejose pusėse
  (rašymo ir skaitymo); `readContextSizeMetrics`/`readCompressionMetrics` analogo
  reikalinga patikra (baigtinis ne-neigiamas skaičius arba absent), kad sugadinta
  reikšmė failtų greitai, o ne poisonintų vidurkius.
