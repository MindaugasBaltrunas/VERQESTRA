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
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (design.md p.1 „Vieno-įrašo lentelė lieka autoritetas“, spec.md „## Added“)
- `src/application/context-pack/metrics.ts:119` — esama `COMPRESSION_METRIC_FIELDS` lentelė

## Tikslas
Pridėti dvi NAUJAS neprivalomas shadow matavimo laukų poras, kad `dispatch_tool_schema` ir `compact_dsl` vėliavos turėtų kur rašyti savo „su vs be“ dydžius. Tik schemos/kontrakto pamatas — jokių rašytojų ir jokio verdikto keitimo šiame darbe.

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> architect -> data-model -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/metrics.ts`
- `src/tests/context-pack-metrics.test.ts`

Draudžiama:
- `AG/**`
- `vq/**`
- `.env`
- `src/interfaces/http/ui-compression-view.ts`
- `ui-app/src/**`

## Veiksmas
- Į `ContextCompressionMetricsInput`, `ContextCompressionMetrics` ir `COMPRESSION_METRIC_FIELDS` pridėti dvi poras tuo pačiu būdu kaip 032 pridėjo `rawPromptChars`/`compiledPromptChars`: `toolSchemaFullChars`/`tool_schema_full_chars` + `toolSchemaReducedChars`/`tool_schema_reduced_chars` (dispatch_tool_schema) ir `dslIrChars`/`dsl_ir_chars` + `dslCompiledChars`/`dsl_compiled_chars` (compact_dsl).
- Laukai NEPRIVALOMI (`exactOptionalPropertyTypes` — per sąlyginį spread'ą): nesantis matavimas yra `undefined`, NIEKADA `0`. Nenaudoti pakartotinai `irJsonChars`/`compiledTaskChars` — jie priklauso `worker_task_ir` porai ir maišytų dvi vėliavas. Jokių šalutinių spread'ų šalia lentelės.
- Testuose padengti: naujos poros keliauja per lentelę abiem kryptimis (input -> record ir atgal), praleistas laukas lieka `undefined`, o esamos poros elgesys nepakitęs.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok ir klausk, jei paaiškėja, kad naujiems laukams reikia keisti `contextPackSchema` prasmę arba kelti `CONTEXT_CACHE_VERSION` (pack'o turinys šiame darbe nesikeičia — jei atrodo, kad keičiasi, tai signalas, kad nuklysta iš scope).

## Neįtraukta
- `bash_output_digest` rašytojas `post-hooks.ts` (kitas darbas).
- `symbol_slices` surinkimo-meto SRC/SIG skaičiavimas (kitas darbas).
- `dispatch_tool_schema` ir `compact_dsl` rašytojai (kiti darbai).
- `FEATURE_PAIR_SELECTORS` / `decideCompression` apibendrinimas ir `ui-app` vertimai (kiti darbai).
- Vėliavų įjungimas ir benchmark kohortos.
