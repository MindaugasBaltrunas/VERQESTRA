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

## Priklausomybės
- 073-registraciju-valymas-visuose-worktree-salinimo-keliuose
- 074-neintegruoto-w2-darbo-apsauga-po-proceso-luzio
- 078-worktree-bootstrap-buildstamp-ir-pnpm-path-spragos
- 079-orphan-valymas-iveikia-untracked-failus-ir-fs-liekanas
- 080-vaiko-exit-visada-palieka-diagnoze-ir-stderr

## Tikslas
Surišti vaike 2 sukurtas kanoniškumo taisykles su verdiktu: `src/interfaces/cli/dispatch/claude-preflight/preflight-validate.ts` esant pažeidimui grąžina `reformulate`, o ne `dispatch`, ir žinutėje cituoja konkrečią pažeistą etalono taisyklę.

## Agentai
Privaloma grandinė, būtent šia tvarka: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/preflight-validate.ts`
- `src/tests/interfaces-cli-preflight.test.ts`

Draudžiama:
- `src/application/quality-gates/preflight-fastpath.ts`
- `src/domain/tasks/sections.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-llm.ts`
- `AG/tasks/examples/000-etalonas.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: nustatyti, kurioje verdikto šakoje pažeidimai turi virsti `reformulate` ir kaip jie nekonfliktuoja su esamais fastpath praėjimo keliais.
- Coder: perduoti pažeidimų sąrašą į verdiktą; reformulate priežastis turi turėti taisyklės citatą, ne bendrinį tekstą.
- Tester: task'as su pažeidimu → `reformulate` su citata; etaloną atitinkantis task'as → esamas verdiktas nepakitęs (regresijos testas).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei surišimas reikalautų keisti `preflight-fastpath.ts` public kontraktą.

## Neįtraukta
Pačios taisyklės (vaikas 2), generatorių prompt'ai (vaikas 4), `sections.ts` keitimas.
