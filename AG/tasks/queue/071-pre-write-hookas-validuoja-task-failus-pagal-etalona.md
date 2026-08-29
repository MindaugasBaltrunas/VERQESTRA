# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 operatoriaus reikalavimas — „Claude Code visada žinotų kaip teisingai kurti task ir nebūtų juose klaidų"; garantija = blokavimas rašymo momentu

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 070-etalonas-maitina-generatorius-ir-preflight-varta

## Žingsnis 0 — ar jau įgyvendinta?
Jei pre-write hook'as, gavęs rašymą į `AG/tasks/{queue,active,delegated}/
*.md`, tikrina etalono struktūrą ir pažeidimą BLOKUOJA su konkrečia
taisyklės žinute — ALREADY_IMPLEMENTED su failo/eilučių įrodymu.

## Tikslas
Trečias (paskutinis) etalono garantijos sluoksnis. CLAUDE.md instrukcija
(žinios kiekvienai sesijai) ir 070 preflight vartas (patikra prieš
dispatch'ą) neapsaugo nuo VIENOS spragos: task'as, parašytas bet kurios
Claude sesijos ar rankos, iki preflight'o gali gulėti eilėje klaidingas,
o preflight jį pagaus tik atėjus jo eilei. Rašymo momento hook'as klaidą
grąžina autoriui PO SEKUNDĖS — kol kontekstas dar gyvas ir pataisymas
kainuoja vieną Edit.

Validacija (šerdis ta pati kaip 070 varto — importuojama iš TO PATIES
modulio, ne kopija; jei 070 dar neįgyvendintas — taisyklių modulis
kuriamas čia, o 070 jį importuos):

1. Privalomos sekcijos etalono tvarka (`## Spec source`, `## Žingsnis 0`,
   `## Tikslas`, `## Agentai`, `## Failai` su Leidžiama/Draudžiama,
   `## Veiksmas` arba etalono leidžiama išimtis, `## Patikra`, `## Stop`,
   `## Neįtraukta`).
2. `## Failai`: katalogo wildcard'as be pagrindimo eilutės šalia — BLOKAS.
3. `## Priklausomybės`: placeholder'iai (none/-/TBD) — BLOKAS; nuoroda į
   neegzistuojantį task id — BLOKAS su radiniu, kur ieškota.
4. `## Patikra`: komandos ne iš leistinų formų sąrašo — BLOKAS su leistinų
   sąrašu žinutėje.

Blokavimo žinutė VISADA įvardija pažeistą taisyklę ir cituoja etalono
kelią. Hook'as taikomas TIK task bucket'ams — `AG/tasks/examples/**`,
`done/**`, `human-review/**` (ten failai jau istoriniai arba etalonas
pats) nevaliduojami.

Suderinamumas: prieš įjungiant, validatorius paleidžiamas ant VISŲ esamų
queue/active failų — jei kuris nepraeina, taisyklė švelninama arba failas
taisomas ATSKIRAI (žr. CLAUDE.md lint vartų pamoką).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/hooks/pre-hooks.ts`
- `src/interfaces/hooks/scope-guards.ts`
- `src/domain/tasks/etalonas-rules.ts` (numatomas naujas — grynos
  validacijos taisyklės, dalinamos su 070 vartu)
- `src/tests/interfaces-hooks-pre-hooks.test.ts`
- `src/tests/domain-tasks-etalonas-rules.test.ts` (numatomas naujas)

Draudžiama:
- `src/domain/tasks/sections.ts` (parseris nekeičiamas)
- `src/application/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: taisyklių modulio vieta (domain/tasks — gryna funkcija
  `validateTaskAgainstEtalonas(text): Violation[]`) ir hook'o prijungimo
  taškas pre-hooks grandinėje; suderinti su 070, kad abu naudotų TĄ PATĮ
  modulį.
- Coder: taisyklės + hook'o šaka + žinutės su etalono citata.
- Tester: kiekvienai taisyklei blokavimo atvejis + visų esamų queue failų
  praėjimo testas + examples/done/human-review nevalidavimo atvejis.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei esamas queue task'as
nepraeina naujos taisyklės.

## Neįtraukta
Preflight varto pusė ir generatorių prompt'ai (070). Etalono turinio
keitimas. Turinio kokybės vertinimas (tik struktūra — prasmę tikrina
preflight LLM).
