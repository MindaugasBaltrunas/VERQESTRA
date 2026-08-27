# Proposal

## Why

`persist.ts` shadow'as šiandien rašo `raw_task_chars` (visas task kūnas) prieš
`ir_json_chars` (WorkerTaskIR JSON be preambulės, be execution context'o). Nė vienas iš
šių dviejų skaičių nėra tai, ką worker'is realiai gauna kaip vieną prompt'ą — tikras
dispatch'as (`resolveCanonicalWorkerPrompt`, `application/task-execution/execution-context-gate.ts`)
sulipdo task kūną (kompiliuotą ARBA raw, priklausomai nuo gate sprendimo) SU tuo pačiu
execution context'u, kurį `persist.ts` jau renderina (`renderExecutionContext`) ir įrašo
kaip `execution-context.md`.

2026-08-26 kompresoriaus auditas parodė, kad šis skirtumas nėra kosmetinis: IR
prompt'as vidutiniškai +54% didesnis už kūną vien dėl execution context'o, o kūno lygio
matavimas rodo tik +27%. Sprendimas „ar kompresija verta" (`decideCompression` UI
endpoint'e) šiandien remiasi kūno lygio pora ir sistemingai per švelniai vertina realią
worker'io kainą — tai reiškia, kad UI gali rekomenduoti įjungti `worker_task_ir` net
tada, kai pilnas prompt'as realiai didėtų.

Užduotis: pridėti PROMPT'O lygio shadow porą (raw prompt vs kompiliuotas prompt, abu su
TUO PAČIU execution context'u) į `context-size.jsonl`, kad sprendimo klausimas atsakinėtų
teisingu dydžiu, neišmetant senų laukų ir nelaužant esamų skaitytojų.

## Scope

- `src/application/context-pack/metrics.ts` — du nauji NEPRIVALOMI shadow laukai
  `ContextCompressionMetricsInput`/`ContextSizeMetricsRecord` lentelėse (prompt'o lygio
  raw/compiled pora), atskiri nuo jau deklaruoto (bet dar nerašomo jokio rašytojo)
  `worker_prompt_chars` — tas laukas rezervuotas REALIAM dispatch'o prompt'ui, ne shadow
  spėjimui, ir jo prasmės maišyti negalima (žr. Architecture Boundaries).
- `src/application/context-pack/assemble/persist.ts` — shadow apskaičiuoja abi prompt'o
  variacijas TUO PAČIU keliu, kuriuo eina realus dispatch'as (per
  `resolveCanonicalWorkerPrompt` arba jo bendrą pod-funkciją iš
  `application/task-execution/execution-context-gate.ts`), naudodamas TĄ PATĮ jau
  paskaičiuotą execution context markdown'ą (`rendered.markdown`/`executionContextBody`),
  o ne antrą render'į su kitokia semantika.
- `src/interfaces/http/ui-compression-view.ts` — nauja telemetrijos pora
  (`prompt_compared_count`, `prompt_smaller_count`, `avg_prompt_delta_percent`) šalia
  esamos IR poros; `decideCompression` verdiktas persijungia prie prompt'o lygio poros,
  kai mėginių pakanka (`>= MIN_DECISION_SAMPLES`), kitaip lieka prie dabartinės (kūno
  lygio) logikos — jokio regreso, kai naujų laukų dar nėra.
- `ui-app/src/**` — tik sakiniai, kurie įvardija, KAS lyginama (prompt'as, ne vien IR
  kūnas); vertimų raktai, ne nauja UI struktūra.

## Out Of Scope

- Dedup logika (task 029 — šis task'as priklauso nuo jo per `depends_on`).
- IR/preambulės formato keitimai (030, 031).
- Benchmark paketo kompresijos kohortos.
- Realaus dispatch'o `worker_prompt_chars` rašytojo įgyvendinimas (interfaces/dispatch
  sluoksnis) — tai atskira, jau deklaruota, bet nerašoma spraga; šis task'as jos
  neliečia ir neužpildo tuo pačiu lauku.
- `execution-context-gate.ts` elgesio keitimas — jis tik importuojamas/naudojamas
  skaitymui iš `persist.ts`, jo failas nėra `## Failai / Leidžiama` sąraše.

## Architecture Boundaries

- **Paliečiamas modulis/paketas:** `application/context-pack` (metrics + persist),
  `interfaces/http` (kompresijos UI vaizdas), `ui-app` (vertimai/sakiniai). Sluoksnių
  riba nekeičiama: `application` importuoja tik `application`/`domain`/`shared`,
  `interfaces` — `interfaces`/`application`/`domain`/`shared` (NE infrastructure).
- **Reads:** `vq/logs/context-size.jsonl` (skaito `ui-compression-view.ts` per esamą
  `readContextSizeLog` portą; nauja DB nenaudojama — tai append-only JSONL, ne SQL).
- **Writes:** `vq/logs/context-size.jsonl` (papildomas `appendContextSizeMetrics`
  kvietimas `persist.ts`, du nauji NEPRIVALOMI laukai kiekviename įraše, kai shadow
  apskaičiuojamas; sena eilutė be jų lieka galiojanti).
- **Job types:** nėra naujo job tipo — pakeitimas gyvena esamoje context-pack assembly
  eigoje (cache hit ir miss keliuose), ne atskirame worker'yje.
