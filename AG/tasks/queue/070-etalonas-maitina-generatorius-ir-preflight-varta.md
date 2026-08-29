# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 operatoriaus užsakymas — etaloninis task šablonas privalo maitinti visus task generatorius

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei preflight reformulacijos/skėlimo prompt'ai įtraukia
`AG/tasks/examples/000-etalonas.md` turinį (ar jo santrauką), o
deterministinė kanoniškumo patikra tikrina etalono taisykles (wildcard
draudimą, testų deklaravimą, UI privalomus failus) — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-28 per parą įvyko 5 parkavimaisi „changed files outside allowed
paths" (059-d, 065, 066-a, 066-b, 067-a), 2 nepavykę auto-skėlimai
(duplicate_scope: 058, 063 dalis) ir keli sandbox atmetimų nudeginti
bėgimai — visų šaknis ta pati: task'us kuriantys LLM žingsniai
(reformulacija, skėlimas, follow-up'ai) neturi privalomo šablono ir
kiekvieną kartą improvizuoja atributus.

Etalonas jau sukurtas: `AG/tasks/examples/000-etalonas.md` (2026-08-29,
operatoriaus patvirtintas). Šis task'as jį prijungia dviem taškais:

1. **Generatorių prompt'ai** (`interfaces/cli/dispatch/claude-preflight/
   preflight-llm.ts`): reformulacijos ir skėlimo prompt'ai gauna etalono
   turinį (arba iš jo išvestą kompaktišką taisyklių sąrašą) kaip privalomą
   šabloną — kuriamas/perrašomas task'as privalo atitikti sekcijas ir
   taisykles. Skėlimo prompt'as papildomai: vaikų scope NEGALI persidengti
   (duplicate_scope prevencija) ir UI vaikas deklaruoja priklausomybę nuo
   serverio vaiko.
2. **Deterministinis vartas** (`application/quality-gates/
   preflight-fastpath.ts` + `interfaces/cli/dispatch/claude-preflight/
   preflight-validate.ts`): „task already canonical" patikra išplečiama
   etalono taisyklėmis — katalogų wildcard'ai be pagrindimo eilutės,
   produkcinis failas be testo failo sąraše, UI failai be I18nContext/
   dashboard.css, Patikra su neleistinomis komandų formomis, Priklausomybės
   su placeholder'iais. Pažeidimas → reformulate verdiktas (ne dispatch),
   su konkrečia pažeistos taisyklės žinute.
3. **Sinchronizacijos vartas**: naujas testas, kuris tikrina, kad etalono
   failo sekcijos sutampa su `domain/tasks/sections.ts` parseriu — šablonas
   negali tyliai išsiskirti nuo to, ką skaito planuoklė.

Kryptis griežtinanti: taisyklė įjungiama tik patikrinus ją prieš VISUS
esamus queue/examples task'us (žr. CLAUDE.md lint taisyklių pamoką) —
vartas, kuris parkuoja visą esamą eilę, yra blogesnis už jo nebuvimą.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/preflight-llm.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-validate.ts`
- `src/application/quality-gates/preflight-fastpath.ts`
- `src/tests/interfaces-cli-dispatch-plan.test.ts`
- `src/tests/quality-gates-preflight-fastpath.test.ts` (numatomas; jei
  testas gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)
- `src/tests/task-etalonas-sync.test.ts` (naujas — 3 punkto vartas)
- `AG/tasks/examples/000-etalonas.md` (TIK jei sinchronizacijai reikia
  smulkaus formos pataisymo; turinio taisyklės nekeičiamos)

Draudžiama:
- `src/domain/tasks/sections.ts` (parseris — tiesos šaltinis, prie jo
  lygiuojamasi, jis nekeičiamas)
- `src/application/task-execution/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: nuspręsti, ar prompt'ai gauna pilną etaloną, ar iš jo
  deterministiškai išvedamą santrauką (dydžio/tokenų kompromisas — žr.
  worker-prompt-compilation preambulės pamoką: šablonas irgi turi
  atsipirkti); kur gyvena etalono kelio konstanta.
- Coder: prompt'ų papildymas + vartų taisyklės + reformulate žinutės su
  pažeistos taisyklės citata.
- Tester: (a) task'as su wildcard be pagrindimo → reformulate su teisinga
  žinute; (b) UI task'as be I18nContext → reformulate; (c) etalono failo
  sekcijų pervadinimas → sync testas raudonas; (d) visi ESAMI queue
  task'ai pro naują vartą praeina.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei kuri nors etalono
taisyklė priverstų parkuoti esamą queue task'ą — taisyklė tada švelninama
arba task'as taisomas ATSKIRAI, ne šio task'o viduje.

## Neįtraukta
`sections.ts` parserio keitimas. Follow-up/audit-repair generatorių
prompt'ai kituose moduliuose (jei architect'as ras — ataskaitoje kaip
atskiras task'as). Esamų queue task'ų perrašinėjimas.
