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
openspec/changes/verqestra-backlog-v1/

## Tikslas
Neintegruotas preserved darbas turi buti MATOMAS, ne archeologuojamas: 2026-08-28/29 sesijos rankinis 6 task'u recovery kainavo kelias zmogaus valandas. `status` komanda parodo preserved darbu sarasa su task id ir apimtimi. Remiasi ankstesniais dviem darbais (patvarus irasas + `preserved-ref-reconcile.ts` sutaikinimas).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidziama:
- `src/interfaces/cli/admin/status.ts`
- `src/tests/interfaces-cli-admin.test.ts`

Draudziama:
- `src/interfaces/cli/bootstrap/rollback-stable.ts`
- `src/infrastructure/git/preserved-ref-reconcile.ts`
- `src/infrastructure/git/preserved-ref-retention.ts`
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Veiksmas
- `statusCommand` gauna preserved darbu sarasa per nauja `StatusPorts` lauka (interfaces neimportuoja infrastructure — duomenys ateina portu); kiekviena eilute: task id arba `unattributed`, ref sha, failu skaicius, data.
- Preserved sekcija spausdinama tik kai sarasas netuscias; portui nepavykus — viena aiski eilute apie nezinia, ne tyli tuscia sekcija.
- Testai: sarasas su dviem irassais (vienas atributuotas, vienas `unattributed`) atsiduria isvestyje; tuscias sarasas sekcijos nespausdina; porto klaida duoda matoma eilute ir nekrenta.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros zalios. Sustok, jei porto surisimui prireiktu keisti `composition` wiring apimtimi, kurios si uzduotis neapima.

## Neitraukta
Patvarus irasas ir sutaikinimo modulis (ankstesni darbai). Ref'u trynimo politika (075 scope). Automatinis preserved darbo atkurimas (063 scope). Dashboard vaizdas (065).
