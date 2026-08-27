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
Pridėti gryną `stripVerificationPreamble(taskText)` taisyklę šalia `verificationPreamble`, kuri nuima VEDANČIUS „## Žingsnis 0" ir „## Sandbox taisyklės" blokus. Invariantas: task failas yra TURINYS be preambulės, sena preambulė įvestyje — pašalintina liekana. Šis task'as taisyklės dar NEprijungia.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/quality-gates/preflight-rules.ts`
- `src/tests/quality-gates-preflight.test.ts`

Draudžiama:
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts`
- `src/application/task-planning/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- `preflight-rules.ts`: eksportuok gryną `stripVerificationPreamble(taskText: string): string` šalia `verificationPreamble` (eil. ~147); ribas rask per jau importuotą `shared/markdown.findSectionBounds` su prefikso predikatu (antraštės neša laisvus sufiksus, plg. `worker-task-ir` DIRECTIVE_HEADING_PREFIXES), nuimk tik VEDANČIUS blokus iki pirmos kitos antraštės.
- Nekeisk `verificationPreamble` išvesties ir nepridėk naujų importų už `shared/**` ribų.
- `quality-gates-preflight.test.ts`: testai grynai taisyklei — vedantis blokas nuimamas; ne-vedantis (po `# Task`) NEnuimamas; fence bloke cituojama „## Sandbox taisyklės" antraštė lieka nepaliesta; tekstas be preambulės grįžta nepakitęs.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei sprendimas imtų reikalauti keisti `shared/markdown.ts`, `worker-task-ir` kompiliatorių arba task failų turinį bucket'uose.

## Neįtraukta
- Taisyklės prijungimas prie preflight kelių — atskiras sekantis task'as.
- Worker'io „deleguok ir baik turn'ą" elgesys ir Agent įrankio draudimas dispatch'e.
