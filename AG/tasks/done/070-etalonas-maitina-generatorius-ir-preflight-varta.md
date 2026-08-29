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
Įtvirtinti, kad etaloninis task šablonas `AG/tasks/examples/000-etalonas.md` negali tyliai išsiskirti nuo to, ką skaito planuoklė: naujas testas tikrina, kad etalono sekcijų antraštės sutampa su `src/domain/tasks/sections.ts` parserio rezultatu.

## Agentai
Privaloma grandinė, būtent šia tvarka: readme-guard -> tester -> reviewer.

## Failai
Leidžiama:
- `src/tests/task-etalonas-sync.test.ts`

Draudžiama:
- `src/domain/tasks/sections.ts`
- `AG/tasks/examples/000-etalonas.md`
- `src/application/quality-gates/preflight-fastpath.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-llm.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-validate.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Sukurti `src/tests/task-etalonas-sync.test.ts`, kuris nuskaito etalono failą ir per `enumerateTaskSections` bei `normalizeTaskHeading` iš `src/domain/tasks/sections.ts` gauna sekcijų sąrašą.
- Testas tvirtina tikslų laukiamą sekcijų rinkinį ir tvarką: Spec source, Priklausomybės, Žingsnis 0 — ar jau įgyvendinta?, Tikslas, Agentai, Failai, Veiksmas, Patikra, Stop, Neįtraukta; papildomai — kad kiekviena sekcija turi netuščią kūną ir kad parseris nepraleidžia nė vienos `## ` antraštės.
- Testas turi kristi, jei etalono sekcija pervadinama, pašalinama arba parseris jos nebeatpažįsta; žinutė turi įvardyti konkrečią neatitinkančią antraštę.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei testas rodo, kad etalono sekcija parseriui nematoma — etalono ar parserio taisymas yra ATSKIRAS darbas, ne šio task'o viduje.

## Neįtraukta
Deterministinės kanoniškumo taisyklės `preflight-fastpath.ts` (vaikas 2), reformulate verdikto surišimas `preflight-validate.ts` (vaikas 3), generatorių prompt'ų papildymas `preflight-llm.ts` (vaikas 4). `sections.ts` parserio keitimas.
