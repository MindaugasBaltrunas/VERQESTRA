# Task

## Spec source
openspec/changes/verqestra-backlog-v1

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
