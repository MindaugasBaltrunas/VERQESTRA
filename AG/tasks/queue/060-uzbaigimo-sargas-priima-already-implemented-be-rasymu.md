# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatorius patvirtino sargo taisymą po dviejų klaidingų parkavimų per dieną

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei bėgimas su diagnozės verdiktu `done` dėl ALREADY_IMPLEMENTED žymos
nebeparkuojamas į human-review vien dėl to, kad executor'ius nepadarė nė
vieno Write/Edit kvietimo — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-28 du task'ai (054-b-03, 057-a-02) tą pačią dieną buvo parkuoti į
human-review su tuo pačiu prieštaravimu orchestrator.log'e:

```text
CLAUDE DIAGNOSIS: verdict=done reason=... ALREADY_IMPLEMENTED marker
TASK NOT DONE: ... executor made no write-tool calls
```

Zero-writes sargas saugo nuo tuščio bėgimo, kuris NIEKO nepadarė, bet
žymi klaidingai teigiamus: task'as, kurio Žingsnis 0 sąžiningai nustatė
ALREADY_IMPLEMENTED, pagal apibrėžimą NETURI ką rašyti — jo įrodymas yra
ataskaitos eilutė, ne Write kvietimas. Rezultatas: kiekvienas jau
įgyvendintas task'as brangiai (054-b-03 atveju — $1.43 už patvirtinimą)
nueina pas operatorių, nors sprendimas jau priimtas ir patikrintas.

Taisymas — SIAURAS: zero-writes sargas praleidžia bėgimą TIK kai diagnozės
verdiktas yra `done` IR bėgimo ataskaitoje yra ALREADY_IMPLEMENTED žyma su
įrodymu (failai/eilutės). Visi kiti zero-writes atvejai (klaida, tuščias
bėgimas, „padarysiu vėliau") parkuojami kaip iki šiol. Sargas
nesilpninamas — jam pridedama viena teisėta išimtis su dvigubu įrodymu.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/**` — užbaigimo/parkavimo sprendimo
  vieta (architect įvardija tikslų failą; tikėtina write-activity /
  completion gate moduliai; įrašyti tikslius kelius į ataskaitą)
- `src/tests/task-execution-orchestration.test.ts`
- `src/tests/task-execution-completion-gate.test.ts` (numatomas naujas)

Draudžiama:
- `src/domain/tasks/human-review/gates.ts` (rizikos vartai — kitas
  mechanizmas, neliesti)
- `src/interfaces/**`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: surasti tikslų sprendimo tašką („TASK NOT DONE: executor made
  no write-tool calls" eilutės autorių) ir ALREADY_IMPLEMENTED žymos
  kanoninį parserį (jis jau egzistuoja — diagnozė žymą atpažįsta);
  išimtis privalo naudoti TĄ PATĮ parserį, ne naują regex kopiją.
- Testai: (a) zero-writes + ALREADY_IMPLEMENTED su įrodymu → done;
  (b) zero-writes be žymos → human-review kaip dabar; (c) žyma yra, bet
  verdiktas ne `done` → human-review; (d) žyma be įrodymo teksto →
  human-review.

## Patikra
- `pnpm typecheck && pnpm test`

## Stop
Commit'ink, kai patikros žalios. Testų nesilpninti — jei esamas testas
prieštarauja naujai išimčiai, stop ir klausk.

## Neįtraukta
Bash-only darbų (be Write/Edit, bet su realiais pakeitimais per komandas)
legalizavimas — atskiras sprendimas, nes jam reikia kito įrodymo šaltinio
(git diff), ne ataskaitos žymos. Retry/rollback logika. UI pusė.
