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
- 141-a-02-141-b-dispositions-sava-priezastis-atvejui-rasymai

> 2026-09-03 pataisyta: priklausomybė buvo proza („141-b (dispositions priežasčių
> tekstai …)"), ne task id, tad planuoklė ją laikė `missing-dependency` ir
> užblokavo bangą (`LOOP STOP: all-blocked`, 09:51). Tikrasis tėvas yra `done`.

## Tikslas
verify-task re-check žinutėje atskirti „commit missing (executor wrote files, tree dirty)" nuo „work missing (no write-tool calls)", kad human-review įrašas iš karto rodytų, ar problema hook'e, ar darbo iš viso nebuvo.

## Agentai
PRIVALOMA grandinė, tokia tvarka: readme-guard -> debugger -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/task-execution/verify-task.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `src/domain/diagnosis/dispositions.ts`
- `src/interfaces/hooks/on-stop.ts`
- `src/interfaces/hooks/on-stop-context.ts`
- `src/infrastructure/state/task-state-store.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Perduok į verify-task žinutę 141-b priežasties kodą ir suformuok dvi skirtingas human-review žinutes: „commit missing" ir „work missing".
- Neplėsk priėmimo logikos: keičiasi tik įvardijimas ir žinutės turinys, ne verdiktas.
- Testuose padenk abu kelius: rašymai buvo be commit'o, ir rašymų nebuvo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei žinutės skirčiai prireiktų naujo lauko diagnozės kontrakte.

## Neįtraukta
- Stop hook'o commit kelias ir dispositions tekstai — ankstesni task'ai.
- Vaiko human-review verdikto propagacija — 135.
