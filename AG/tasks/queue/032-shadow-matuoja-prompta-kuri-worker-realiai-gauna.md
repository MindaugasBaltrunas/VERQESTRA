# Task

## Spec source
docs/audits/ (kompresoriaus auditas 2026-08-26)
src/application/context-pack/metrics.ts (0032 pastaba: du logai matavo du skirtingus dalykus)

## Tikslas
Shadow telemetrija turi lyginti tą porą, pagal kurią priimamas sprendimas. Dabar
`persist.ts` rašo `raw_task_chars` (task kūnas) vs `ir_json_chars` (IR JSON be preambulės)
— nė vienas iš jų nėra tai, ką worker'is realiai gauna. Sprendimo klausimas yra
„ar prompt'as SU kompresija mažesnis už prompt'ą BE jos" — pilno prompt'o lygyje
(kūnas + execution context po 029 dedup).

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/persist.ts`
- `src/application/context-pack/metrics.ts`
- `src/interfaces/http/ui-compression-view.ts`
- `ui-app/src/**` (tik verdikto šaltinio laukai ir vertimai)
- `src/tests/**`

Draudžiama:
- `AG/**` (etalonas read-only)
- `vq/**`
- `.env`

## Dependencies
depends_on: 029-prompt-nesa-taska-viena-karta-konteksto-dedup.md

## Veiksmas
- FAKTAS: `persist.ts:91-92,115-116` shadow'as matuoja `workerTaskIrChars(ir)` vs
  `input.taskText.length`. Auditas 2026-08-26: reali worker'io kaina yra prompt'o
  lygio (IR prompt +54% vs kūno +27%), tad dabartinis matavimas sprendimo klausimui
  atsako sistemingai per švelniai.
- Pridėti prompt'o lygio shadow porą į `context-size.jsonl` (nauji NEPRIVALOMI laukai
  per `ContextCompressionMetricsInput` lentelę `metrics.ts:103-114` — nesantis matavimas
  yra NESANTIS, ne 0): raw prompt'o dydis ir kompiliuoto prompt'o dydis, abu su tuo
  pačiu execution context'u, koks būtų realiai prisegtas.
- Seni laukai (`raw_task_chars`, `ir_json_chars`, deprecated `compiled_task_chars`)
  lieka rašomi — skaitytojų lūžis draudžiamas.
- `ui-compression-view.ts` verdiktas (`decideCompression`) persijungia prie naujos
  poros, kai ji mėginiuose YRA; be jos — dabartinis elgesys (fallback, ne lūžis).
  UI sakiniai atnaujinami, kad įvardytų, KAS lyginama.
- Slenksčio logika nesikeičia: MIN_DECISION_SAMPLES ir spaudimo lygiai lieka.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei prompt'o lygio matavimui prireiktų
execution context'ą renderinti antrą kartą su kitokia semantika nei reali dispatch
grandinė — matavimas privalo eiti per tą patį kelią, ne per kopiją.

## Neįtraukta
- Dedup logika (task 029 — šis task'as bėga PO jo).
- IR/preambulės keitimai (030, 031).
- Benchmark paketo kompresijos kohortos.
