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
- 141-worktree-stop-hook-commitina-zalia-darba-arba-ivardija-kodel-ne

## Žingsnis 0 — ar jau įgyvendinta?
Jei `enforceExecutionBudget` jau turi kelią, kuriuo `context files N > M` priežastis slopinama esant HUMAN-REVIEW-APPROVED žymai, ARBA failo doc'as EKSPLICITIŠKAI dokumentuoja, kad biudžeto kanalas žymos sąmoningai nepaiso — ALREADY_IMPLEMENTED: cituok kodą/doc'ą ir testą kaip įrodymą.

## Tikslas
Task'as su galiojančia `HUMAN-REVIEW-APPROVED` žyma vis tiek parkuojamas `budget_enforcement_failed=context files 9 > 8`, nors preflight risk kelias tą pačią žymą gerbia, o `assemble.ts:309-313` doc'as sako, kad `max_files` yra ŽMOGAUS PERŽIŪROS slenkstis, ne karpymo limitas. Architect nusprendžia: (A) enforcement gerbia žymą TIK `context files > max` priežastyje, arba (B) nepaisymas sąmoningas ir dokumentuojamas. Šiame task'e keičiamas TIK token-governance enforcement sluoksnis; žymos perdavimas iš dispatch — sekančiame task'e.

## Agentai
PRIVALOMA grandinė (be praleidimų): readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/token-governance/tool-budget-gates.ts`
- `src/tests/token-governance-gates.test.ts`

Draudžiama:
- `src/domain/tasks/human-review/gates.ts`
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `src/application/context-pack/assemble/assemble.ts`
- `src/application/task-execution/dispatch-task.ts`
- `vq/config/context-budget.json`
- `dist/**`
- `node_modules/**`

## Veiksmas
- architect: pasirink (A) ar (B) su pagrindimu ataskaitoje — (A) suderina abu kanalus su dokumentuotu „žmogaus peržiūros slenksčio“ dizainu ir 072 precedentu, slopinimo apimtis SIAURA; (B) pigus, bet palieka klasę be išeities ir palieka prieštaraujančius dizaino tekstus.
- (A) šaka: `enforceExecutionBudget` request gauna neprivalomą `humanReviewApproved?: string`; kai jis yra, `context files > max` priežastis neįtraukiama, o rezultatas gauna „suppressed by HUMAN-REVIEW-APPROVED: <marker>“ eilutę; ledger/hard limitai, model policy, tool allowlist elgiasi kaip iki šiol.
- (B) šaka: sprendimą dokumentuok `tool-budget-gates.ts` doc'e su nuoroda į `assemble.ts:309-313` prieštarą; prieštaros suderinimą fiksuok ataskaitoje kaip likutį, assemble failo NELIESK.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei (A) šakoje request forma reikalautų keisti portų kontraktą už `tool-budget-gates.ts` ribų.

## Neįtraukta
- Žymos išsitraukimas ir perdavimas iš `dispatch-task.ts` / `run-coordinator-ports.ts` / composition adapterio — sekantis task'as 142-b.
- `max_files` ribos reikšmės keitimas.
- Preflight `context files` siuntimo pusės elgesys.
