## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
`worker_prompt_chars` neturi rašytojo visame `src`, todėl `joinPostRunTruth` (`post-run-truth-join.ts:146` gate'ina `worker_prompt_chars === undefined`) visada grąžina 0 eilučių ir task 0042 tokenizer signalai miega. Rašytoją įrašyti `finalizeDispatch` viduje: ten jau yra `input.launchRecord.prompt` (realus išsiųstas worker prompt), `input.launchRecord.workerPrompt?.rawChars`, `input.attempt` ir `attempt_id` formatas `${taskId}:dispatch:${attempt}`, plius jau veikiantis best-effort `buildContextSizeMetrics` + `appendContextSizeMetrics` blokas (`claude-dispatch-finalize.ts:144–160`). Porto ar composition surišimo NEREIKIA.

## Agentai
PRIVALOMA grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/adapters/claude-dispatch-finalize.ts`
- `src/tests/infrastructure-dispatch-flow.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `src/application/context-pack/metrics.ts`
- `src/application/analytics/post-run-truth-join.ts`
- `src/application/context-pack/context-cache-key.ts`

## Veiksmas
- `finalizeDispatch` gale įrašyti context-size įrašą per `buildContextSizeMetrics` + `appendContextSizeMetrics` su `taskId`, `attempt`, `attempt_id`, `workerPromptChars = input.launchRecord.prompt.length` ir `rawTaskChars = input.launchRecord.workerPrompt?.rawChars` (jei `undefined` — lauko neįrašyti, ne 0).
- Rašymas best-effort tame pačiame `try/catch` stiliuje kaip esamas shadow blokas: telemetrijos gedimas negali sulaužyti finalize; esamo shadow įrašo elgesio nekeisti.
- Teste patikrinti: po finalize `context-size.jsonl` turi įrašą su `worker_prompt_chars`, lygiu realiam prompt'o ilgiui, ir su `raw_task_chars`; append klaida (mestas fs) finalize nenutraukia.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei paaiškėtų, kad `launchRecord.prompt` finalize'e nėra tas pats prompt'as, kuris išsiųstas Claude — tada rašymo taškas keliauja į interfaces pusę ir tam reikia atskiro sprendimo, ne tylaus kelio pridėjimo.

## Neįtraukta
`CONTEXT_CACHE_VERSION` kėlimas — sąmoningai ne: pack'o turinys nesikeičia, keičiasi tik telemetrija. `metrics.ts` „no writer in this module" komentaro atnaujinimas ir join'o įrodymo testas — kita užduotis. `post-run-truth-join.ts` ir `tokenizer-unfriendly-signal.ts` — skaitymo pusė jau teisinga. `symbol_slices` shadow pora — task 087.
