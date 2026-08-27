# Proposal

## Why
`decideCompression` (src/interfaces/http/ui-compression-view.ts) turi realų verdiktą tik vienai iš penkių kompresijos vėliavų — `worker_task_ir`. Likusios keturios (`bash_output_digest`, `symbol_slices`, `dispatch_tool_schema`, `compact_dsl`) visada gauna `action: "unmeasured"`, `reason: "no-shadow-measurement"`, nes joms nėra rašomos poros "kiek kainuotų su" vs "kiek kainuoja be" — nors jų VIETA lauko lygyje jau deklaruota (`metrics.ts` `ContextCompressionMetricsInput`: `toolRawChars`/`toolDigestChars` su pastaba "no writer in this module"). `symbol_slices` porai (`symbol_source_chars`/`symbol_signature_chars`) rašytojas yra, bet suveikia TIK kai `symbolFragments.some(tier !== undefined)` — t. y. tik po to, kai vėliava jau įjungta (persist.ts:117); tai apverstas klausimas — operatorius negali sužinoti, ar verta jungti, nesujungęs pirmiau. `dispatch_tool_schema` šiandien žurnale turi tik režimo eilutę (`token-usage-log.ts`: `"applied"|"off"`), jokio dydžio matavimo. `compact_dsl` porą (`irChars`/DSL statistika kompiliacijoje) turi, bet ji niekada nepasiekia `context-size.jsonl`.

Be visų penkių porų operatoriaus sprendimas "ką jungti" lieka spėjimu keturiais atvejais iš penkių — būtent tam sukurtas UI puslapis (2026-08-26) negali atlikti savo darbo.

## Scope
- Keturios NAUJOS arba UŽPILDOMOS shadow poros, po vieną kiekvienai neišmatuotai vėliavai, rašomos į `vq/logs/context-size.jsonl` per esamą `COMPRESSION_METRIC_FIELDS` vieno-įrašo lentelę (`src/application/context-pack/metrics.ts`).
- `bash_output_digest`: užpildyti jau deklaruotus `toolRawChars`/`toolDigestChars` iš PostToolUse Bash hook'o shadow kelio (`src/interfaces/hooks/post-hooks.ts` — `recordBashDigestShadow` jau skaičiuoja digest'ą į atskirą `bash-digest-shadow.jsonl`; ši užduotis prijungia tą patį skaičiavimą prie `context-size.jsonl` per `task_id`).
- `symbol_slices`: perkelti `symbol_source_chars`/`symbol_signature_chars` skaičiavimą (`src/application/context-pack/assemble/persist.ts` ir `tiers.ts`) iš "tik kai tier'ai jau priskirti" į "visada surinkimo metu, nepriklausomai nuo to, ar pack'as renderinamas su tier'ais".
- `dispatch_tool_schema`: naujas shadow matavimas dispatch paruošimo metu (pilnos vs sumažintos MCP schemos dydis), analogiškai 032 užduoties `rawPromptChars`/`compiledPromptChars` porai.
- `compact_dsl`: pratekinti jau egzistuojančią kompiliacijos porą (`compact-dsl/render.ts` `irChars` vs `compiledChars`) į `context-size.jsonl`, jei jos ten dar nėra.
- `decideCompression` apibendrinti nuo vieno hardcoded `worker_task_ir` atvejo į lentelę "vėliava → poros laukai", kad kiekviena vėliava su savo pora gautų tą pačią moka/nemoka/trūksta-mėginių logiką.
- UI (`ui-app`) — nauji priežasčių vertimai naujoms `reason` reikšmėms, jei jų prireiks per lentelės apibendrinimą.

## Out Of Scope
- Bet kurios vėliavos įjungimas config'e ar canary kohortoje.
- `AG/benchmark` paketo kohortos ir jų analizė.
- Prompt'o lygio dedup ir IR struktūros pakeitimai (uždaryta 029/030).
- `worker_task_ir` poros keitimas — ji jau veikia (032) ir šia užduotimi nekeičiama.
- Naujų kompresijos vėliavų pridėjimas prie `CONTEXT_COMPRESSION_FEATURES` registro.

## Architecture Boundaries
- **Moduliai**: `src/application/context-pack/**` (metrics, persist, tiers, gather, compact-dsl), `src/interfaces/hooks/**` (PostToolUse Bash shadow kelias), `src/interfaces/http/ui-compression-view.ts` (decideCompression apibendrinimas), `ui-app/src/**` (tik verdikto priežasčių vertimai).
- **Sluoksnių ribos**: `application` sluoksnis (metrics/persist/tiers/gather/compact-dsl) gali importuoti tik iš `application`, `domain`, `shared` — jokio `infrastructure`. `interfaces/hooks` ir `interfaces/http` gauna efektus per portus (`ContextPackFileSystemPort`, esami hook'ų portai), naujų infrastruktūros importų NEreikia — visi rašymo taškai jau turi FS portą.
- **Reads**: `vq/logs/context-size.jsonl` (esamas), `vq/config/context-compression.json` (esamas, per `loadConfig`/`loadCompressionConfig` portus).
- **Writes**: `vq/logs/context-size.jsonl` — TIK nauji NEPRIVALOMI laukai per `COMPRESSION_METRIC_FIELDS`; jokio schema breaking change esamiems skaitytojams. `bash-digest-shadow.jsonl` lieka (esamas atskiras žurnalas), jei jo skaičiavimas pakartotinai naudojamas `context-size.jsonl` įrašui — sprendžia architect/coder, ar dubliuoti skaičiavimą, ar dalintis viena funkcija.
- **Job types**: nėra. Visi matavimai vyksta sinchroniškai esamuose best-effort telemetrijos keliuose (hook'o PostToolUse, context-pack assembly, dispatch paruošimas) — ne atskiras worker/job.
- **DB**: nėra — visa telemetrija yra append-only JSONL faile, ne DB lentelė.
