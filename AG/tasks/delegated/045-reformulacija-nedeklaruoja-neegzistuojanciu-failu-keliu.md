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
Pridėti gryną taisyklę, kuri iš task teksto `## Failai / Leidžiama` sekcijos atrenka ĮRODYTAI klaidingus kelius: konkretų kelią, kurio TĖVINIS KATALOGAS neegzistuoja. Egzistuojantis katalogas + dar nesamas failas lieka leidžiamas (normalus „naujas testų failas"). Glob'ai (`**`, `*`) nekeičiami. Fail-open: abejotinas kelias paliekamas.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/quality-gates/preflight-rules.ts`
- `src/application/quality-gates/allowed-path-existence.ts`
- `src/tests/quality-gates-preflight.test.ts`

Draudžiama:
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts`
- `src/interfaces/hooks/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Naudok esamą `allowedPaths` parserį iš `src/domain/tasks/allowed-paths.ts`; nekurk antro parserio.
- Eksportuok gryną funkciją (pvz. `detectHallucinatedAllowedPaths(taskText, dirExists)`), kur `dirExists: (dir: string) => boolean` yra injektuojamas predikatas — jokio `node:fs` importo application sluoksnyje. Grąžink klaidingų kelių sąrašą (tuščias = viskas gerai).
- Jei `preflight-rules.ts` viršytų 500 eilučių, taisyklę dėk į naują `allowed-path-existence.ts` ir re-eksportuok.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei sprendimas imtų reikalauti keisti `interfaces/hooks` scope guard'us arba tiesioginį IO application sluoksnyje.

## Neįtraukta
- Prijungimas prie LLM reformulacijos (`preflight-llm.ts`) — atskira užduotis.
- Prijungimas prie task skaidymo (`task-splitting.ts`) — atskira užduotis.
- Scope guard'o / rollback elgesys — veikė teisingai.
