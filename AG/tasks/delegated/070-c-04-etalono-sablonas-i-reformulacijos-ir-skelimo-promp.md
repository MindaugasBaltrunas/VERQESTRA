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
Reformulacijos ir skėlimo prompt'ai `src/interfaces/cli/dispatch/claude-preflight/preflight-llm.ts` gauna etalono šabloną kaip privalomą, kad LLB žingsniai nebeimprovizuotų task'o atributų (5 parkavimaisi „changed files outside allowed paths" ir 2 `duplicate_scope` skėlimai per 2026-08-28 parą).

## Agentai
Privaloma grandinė, būtent šia tvarka: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/preflight-llm.ts`
- `src/tests/interfaces-cli-dispatch-plan.test.ts`

Draudžiama:
- `src/domain/tasks/sections.ts`
- `src/application/quality-gates/preflight-fastpath.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-validate.ts`
- `AG/tasks/examples/000-etalonas.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: nuspręsti, ar prompt'as gauna pilną `AG/tasks/examples/000-etalonas.md` turinį, ar deterministiškai iš jo išvestą kompaktišką taisyklių santrauką (tokenų kompromisas — šablonas irgi turi atsipirkti), ir kur gyvena etalono kelio konstanta.
- Coder: papildyti reformulacijos prompt'ą šablonu; skėlimo prompt'ą papildomai — vaikų `## Failai` scope NEGALI persidengti (duplicate_scope prevencija) ir UI vaikas deklaruoja priklausomybę nuo serverio vaiko.
- Tester: prompt'ų testai tvirtina, kad abu prompt'ai turi etalono sekcijų sąrašą, o skėlimo prompt'as — abu papildomus reikalavimus.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei etalono kelio konstanta reikalautų naujo porto ar sluoksnio ribos kirtimo.

## Neįtraukta
Deterministinės vartų taisyklės (vaikas 2), reformulate surišimas (vaikas 3), follow-up/audit-repair generatorių prompt'ai kituose moduliuose — jei architect'as juos ras, į ataskaitą kaip atskirą task'ą.
