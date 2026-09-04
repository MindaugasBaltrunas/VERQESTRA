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

## Tikslas
Patikrinti, ar `templates/vq/config/token-budget.json` `turnLimits` sutampa su `DEFAULT_TURN_LIMITS` (medium 90, repair 45, small 20, large 180, semanticReview 12) po modelių audito R1–R3 kalibracijos. Jei sutampa — NEDARYTI pakeitimų, ataskaitą pradėti `ALREADY_IMPLEMENTED:` eilute cituojant abu failus.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `templates/vq/config/token-budget.json`

Draudžiama:
- `vq/config/**`
- `src/**`
- `dist/**`

## Veiksmas
- Perskaityti `templates/vq/config/token-budget.json` turnLimits lauką.
- Palyginti su `src/application/token-governance/turn-budget.ts` DEFAULT_TURN_LIMITS.
- Jei reikšmės sutampa, ataskaitą pradėti `ALREADY_IMPLEMENTED:`; jei ne — atnaujinti JSON reikšmes į 90/45.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink tik jei teko keisti JSON; jei tik patikrinai ir sutampa, nekeisk nieko.

## Neįtraukta
- Gyvo `vq/config/token-budget.json` redagavimas — operatoriaus žingsnis.
