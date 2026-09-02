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
Po SSE kelio pataisymo dashboard'o snapshot'as lieka antras fosilijos šaltinis: veiklos stamp'as `src/composition/ui/dashboard-adapters.ts:171` vis dar remiasi numatytuoju `vq/logs/claude-last.log` veidrodžiu, tad pirmas puslapio užkrovimas worktree dispatch'o metu parodys seną komandą, kurią SSE tik vėliau pakeis. Stamp'as turi naudoti tą pačią gyvo šaltinio rezoliuciją kaip SSE, o jos nesant — tuščią veiklą. Priklausomybė: 139-b-01 baigtas (iš jo imama rezoliucija).

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/composition/ui/dashboard-adapters.ts`
- `src/tests/composition-ui-dashboard-live-activity.test.ts` (naujas; jei paaiškėtų, kad dengimas priklauso esamam `composition-ui-dashboard-contract.test.ts`, naudok numatytą naują failą ir esamo neliesk)

Draudžiama:
- `src/composition/ui/sse-adapters.ts`
- `src/interfaces/ui-model/agent-activity-reader.ts`
- `src/tests/composition-ui-sse-live-updates.test.ts`
- `src/tests/interfaces-ui-model-agent-activity.test.ts`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Perjunk snapshot'o veiklos stamp'ą į tą pačią gyvo šaltinio rezoliuciją, kurią naudoja SSE adapteris (gyvas lease su `worktree_path` → worktree bandymo log'as).
- Gyvo šaltinio nesant grąžink tuščią veiklą — legacy veidrodžio turinys į snapshot'ą nebepatenka.
- Testai: worktree dispatch → stamp'as iš gyvo srauto; gyvo šaltinio nėra, veidrodis senas → tuščia; ne-worktree dispatch → esamas elgesys žalias.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei sąžiningam tuščios būsenos pateikimui prireiktų naujų UI tekstų (`ui-app/**` — atskira grandinė).

## Neįtraukta
- SSE kelias — 139-b-01.
- Skaitytojo semantika — 139-a-01.
- Gyvas TEE į tėvo attempt kelią — atskiras task'as.
