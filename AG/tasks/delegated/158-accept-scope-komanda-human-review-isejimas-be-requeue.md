## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- Nėra.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/tasks/failai-scope-edit.ts` jau eksportuoja `acceptScopePaths` ir
`src/tests/domain-tasks-failai-scope-edit.test.ts` žalias — ALREADY_IMPLEMENTED: cituok eksporto
signatūrą ir testo pavadinimus.

## Tikslas
Grynas domain redaktorius, kuris task'o markdown'e į `## Failai` sekciją įrašo priimtą kelią ir
datuotą pastabą. Tai tekstinė dalis būsimos `accept-scope` komandos, uždarančios human-review
`rollback_failed` parkus (darbas žalias, bet vienas kelias nebuvo `## Failai` sąraše) be requeue.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/failai-scope-edit.ts`
- `src/tests/domain-tasks-failai-scope-edit.test.ts`

Draudžiama:
- `src/domain/tasks/allowed-paths.ts`
- `src/domain/tasks/etalonas-rules.ts`
- `src/interfaces/cli/task-queue/requeue.ts`
- `src/composition/cli/commands-tasks.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Sukurk gryną `acceptScopePaths(markdown, paths, note)` → `ok(newMarkdown)` / `err`: jokio `node:`
  importo, jokio IO, data perduodama argumentu (ne `Date.now()` viduje).
- Datuota `> ` pastaba įterpiama tuoj po `## Failai` antraštės, PRIEŠ `Leidžiama:` (parseris
  `src/domain/tasks/allowed-paths.ts:50-57` ten jos nemato); keliai pridedami `Leidžiama:` sąrašo
  gale forma `- \`kelias\``; idempotentiška — esamas kelias nekartojamas; be `## Failai` — `err`.
- Testai: pastaba virš `Leidžiama:`, kelias sąrašo gale, pakartotinis kvietimas nieko nekeičia,
  trūkstama sekcija → `err`, o rezultatas praeina `validateTaskAgainstEtalonas`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Privaloma nurodyta agentų grandinė. Commit'ink, kai abi patikros žalios. Stop ir klausk, jei
pastabos įterpimas reikalautų keisti `allowed-paths.ts` parserį — tada keičiasi kontraktas, ne
redaktorius.

## Neįtraukta
- CLI komanda `accept-scope.ts` ir bucket'o perkėlimas — kita dalis.
- Registras `commands-tasks.ts` ir README „Task queue" eilutė — vėlesnės dalys.
- Šakos merge iš CLI (git mutacija) — operatoriaus darbas.
