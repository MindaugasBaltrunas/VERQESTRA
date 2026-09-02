# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 153-allowed-paths-lauzytas-bulletas-yra-vienas-loginis-irasas (domain sulankstymas `src/domain/tasks/allowed-paths.ts`)

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/scheduling-conflict-detector.test.ts` jau turi atvejį, kur task teksto `## Failai` bullet'as laužytas per kelias eilutes ir pagrindimo identifikatorius (pvz. `MIN_ARCHITECTURE_TOKEN_LENGTH`) stovi tęstinėje eilutėje backtick'uose, o `computeTaskWriteSet` grąžina scope TIK iš tikrų kelių — atsakyk ALREADY_IMPLEMENTED ir cituok testą. Nieko nekeisk.

## Tikslas
Domain parseris jau sulanksto laužytą bullet'ą į vieną loginį įrašą. Trūksta integracinio įrodymo aukščiau: scheduling write-set skaičiavimas, kuris maitina lygiagretumo sprendimą, iš 143 formos teksto turi gauti scope tik iš kelių — ne iš pagrindimo identifikatorių, kurie kitaip virstų fantominiais write set įrašais ir tyliai darytų nesusijusias užduotis nuosekliomis.

## Agentai
Privaloma grandinė: readme-guard -> tester -> reviewer.

## Failai
Leidžiama:
- `src/tests/scheduling-conflict-detector.test.ts`

Draudžiama:
- `src/domain/tasks/allowed-paths.ts`
- `src/tests/domain-tasks.test.ts`
- `src/application/quality-gates/preflight-rules.ts`
- `src/application/quality-gates/preflight.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Pridėk `src/tests/scheduling-conflict-detector.test.ts` atvejį su realia 143 forma: `` - `src/application/context-pack/assemble/gather.ts` (TIK `` + tęstinė eilutė `` MIN_ARCHITECTURE_TOKEN_LENGTH` eksportas — dabar failo vidinis `const`) ``.
- Tvirtink, kad `computeTaskWriteSet` grąžintas scope turi tik deklaruotą kelią, o `MIN_ARCHITECTURE_TOKEN_LENGTH` ir `const` jame neatsiranda.
- Tik testas — produkcinio kodo nekeisk; failas privalo likti ≤500 eil.

## Patikra
- `pnpm test`

## Stop
Sustok ir klausk, jei testas krenta dėl produkcinio kodo elgesio (t. y. reikėtų keisti `Draudžiama:` failą) arba jei `computeTaskWriteSet` viešas parašas neleidžia tokio atvejo suformuluoti be papildomų pakeitimų.

Kai `pnpm test` žalias — commit'ink ir baik.

## Neįtraukta
- Bet koks produkcinio kodo keitimas.
- Queue failų 152/120 teksto taisymas.
- `worker-task-ir.ts` `parseBulletSection` suvienodinimas.
