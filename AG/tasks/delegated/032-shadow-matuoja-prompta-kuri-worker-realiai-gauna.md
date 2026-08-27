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
- `AG/openspec/changes/auto-032-shadow-matuoja-prompta-kuri-worker-realiai-gau/spec.md`
- `src/application/context-pack/metrics.ts` (0032 pastaba: du logai matavo du skirtingus dalykus)

## Tikslas
Shadow telemetrija turi matuoti tą porą, pagal kurią priimamas sprendimas: prompt'o SU kompresija dydis vs prompt'o BE jos, abu su tuo pačiu execution context'u. Dabar `persist.ts` lygina `workerTaskIrChars(ir)` vs `input.taskText.length` — nė vienas nėra tai, ką worker'is realiai gauna, tad matavimas sprendimo klausimui atsako sistemingai per švelniai.

## Agentai
Privaloma grandinė: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/metrics.ts`
- `src/application/context-pack/assemble/persist.ts`
- `src/tests/context-pack-metrics.test.ts`

Draudžiama:
- `src/interfaces/http/ui-compression-view.ts`
- `ui-app/**`
- `AG/**`
- `vq/**`
- `.env`

## Veiksmas
- `metrics.ts:103-114` lentelėje `ContextCompressionMetricsInput` pridėk du NEPRIVALOMUS laukus: raw prompt'o dydį ir kompiliuoto prompt'o dydį (`exactOptionalPropertyTypes` — per sąlyginį spread'ą; nesantis matavimas yra NESANTIS, ne 0).
- `persist.ts` užpildyk naują porą iš to paties execution context'o kelio, kurį naudoja reali dispatch grandinė — ne iš kopijos ir ne renderinant antrą kartą kitokia semantika.
- Seni laukai (`raw_task_chars`, `ir_json_chars`, deprecated `compiled_task_chars`) lieka rašomi be pakeitimų — skaitytojų lūžis draudžiamas.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei prompt'o lygio matavimui prireiktų execution context'ą renderinti antrą kartą su kitokia semantika nei reali dispatch grandinė, arba jei reikėtų keisti `CONTEXT_CACHE_VERSION` semantiką.

## Neįtraukta
- `ui-compression-view.ts` verdikto persijungimas (atskiras task'as).
- UI sakiniai ir vertimai `ui-app` (atskiras task'as).
- Dedup logika (029), IR/preambulės keitimai (030, 031), benchmark kohortos.
