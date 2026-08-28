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
Isitikinti, kad `verqestra install` deda worktree politika tiksliai i ta kataloga, is kurio ja dabar skaito loop'as (`vq/config/`), ir kad sablono turinys yra galiojantis politikos dokumentas su aiskiu default.

## Agentai
Privaloma grandine: readme-guard -> reviewer.

## Failai
Leidziama:
- `templates/vq/config/worktree-policy.json`

Draudziama:
- `src/**`
- `dist/**`

## Veiksmas
- Perskaityti `templates/vq/config/worktree-policy.json` ir palyginti laukus su `src/application/scheduling/worktree-policy.ts` parserio schema.
- Jei sablono laukai ar default `enabled` neatitinka parserio — suderinti sablona (parseris neliecamas).
- Jei viskas sutampa, palikti be pakeitimu ir tai irasyti ataskaitoje.

## Patikra
- `pnpm test`

## Stop
Commit'ink tik jei sablonas keistas ir patikra zalia. Sustok, jei paaiskeja, kad reikia keisti parseri arba install kodo kelius.

## Neitraukta
Kitu politiku sablonai. Install komandos kodas.
