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
Prijungti jau egzistuojantį `src/infrastructure/git/preserved-ref-retention.ts` prie esamo priežiūros/orphan ciklo `src/composition/loop/command.ts`, kad pasenę `refs/verqestra/preserved/*` ref'ai ir `vq/state/rollback-preserved/*.json` įrašai būtų realiai šalinami.

Pirmiausia Žingsnis 0: jei retencijos žingsnis jau kviečiamas iš priežiūros ciklo, sustok ir raportuok ALREADY_IMPLEMENTED su eilučių įrodymu, nieko nekeisk.

## Agentai
Privaloma grandinė (ta pati eilės tvarka, be praleidimų):
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/command.ts`
- `src/composition/loop/preserved-work-adapters.ts`
- `src/tests/composition-preserved-work-wiring.test.ts`

Draudžiama:
- `src/infrastructure/git/preserved-ref-retention.ts`
- `src/interfaces/hooks/log-rotation.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Suriši retencijos žingsnį manual DI būdu prie esamo priežiūros ciklo `command.ts`, nekurdamas naujo ciklo ir nekeisdamas retencijos modulio logikos ar public kontrakto.
- Retencijos N parų riba ateina per konfigūraciją su numatytąja 14, o ne hardcode'inta ciklo viduje.
- Testas patvirtina: ciklo paleidimas kviečia retenciją su teisingais argumentais, o jos klaida nenutraukia likusio priežiūros ciklo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei prijungimas reikalautų keisti retencijos modulio public kontraktą.

## Neįtraukta
Retencijos vartų logikos keitimas. Ref'ų trynimas `rollback` metu. `git gc` orkestravimas. `hooks.log` rotacija. Eskalacijos sargas (074).
