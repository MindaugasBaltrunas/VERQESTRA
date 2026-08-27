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
Po LLM reformulacijos patikrinti reformuluoto task'o `## Failai` kelius ankstesne užduotimi pridėta taisykle. Radus įrodytai klaidingą kelią (tėvinio katalogo nėra), reformuluoto task'o `## Failai` sekcija PAKEIČIAMA ORIGINALAUS task'o sekcija ir įrašoma garsi `CLAUDE PREFLIGHT: ... hallucinated-allowed-path` log eilutė.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/preflight-llm.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-ports.ts`
- `src/tests/interfaces-cli-preflight.test.ts`

Draudžiama:
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts`
- `src/interfaces/hooks/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Katalogo egzistavimo predikatą imk iš esamų preflight portų (`PreflightFilePorts`); jei reikia, pridėk vieną siaurą metodą prie porto — jokio tiesioginio `node:fs` čia.
- Pakeisk TIK `## Failai` sekciją originalo tekstu; jei originalas turėjo konkrečius kelius, wildcard'as neįrašomas.
- Fail-open: nieko nekeisk, kai klaidingų kelių nerasta arba kelias yra glob'as.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei originalo `## Failai` perėmimas imtų reikšti wildcard'o įrašymą ten, kur originalas turėjo konkrečius kelius.

## Neįtraukta
- Task skaidymo pusė (`task-splitting.ts`) — atskira užduotis.
- Scope guard'o / rollback elgesys.
