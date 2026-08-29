# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Vaiko diagnostika neturi priklausyti nuo orchestrator.log rotacijos. Kai `runChild` (`src/composition/loop/command.ts`) fiksuoja nenulinį vaiko exit, ta pati diagnostika papildomai append'inama į `vq/logs/slots/<worker>-<task>-a<attempt>.log`. Remiasi ankstesne užduotimi, kuri sukūrė `src/composition/loop/child-exit-diagnostics.ts` formatuotoją — naudok jį, netiražuok formatavimo.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester. readme-guard eina pirmas (keičiamas source).

## Failai
Leidžiama:
- `src/composition/loop/child-exit-diagnostics.ts`
- `src/composition/loop/command.ts`
- `src/tests/composition-loop-child-exit-slots-log.test.ts`

Draudžiama:
- `src/application/**`
- `src/infrastructure/**`
- `src/interfaces/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Failo vardą (`<worker>-<task>-a<attempt>.log`, sanitizuotas nuo kelio separatorių) formuok `child-exit-diagnostics.ts` gryna funkcija; rašymą atlik `command.ts` per jau surištą fs/log adapterį, be tiesioginio `node:fs` importo naujame domain kelyje.
- Katalogas `vq/logs/slots` sukuriamas pagal poreikį; įrašas — append, ne overwrite; rašymo klaida nenutraukia slot'o vykdymo (log'inama ir tęsiama).
- Tester: du exit'ai to paties `<worker>-<task>-a<attempt>` sukaupia abu įrašus viename faile; SILENT atvejis irgi patenka į failą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei `command.ts` viršytų 500 eilučių arba tektų keisti `src/application/**`.

## Neįtraukta
Log rotacijos/valymo politika slots kataloge (075). Gedimų priežasčių taisymas (078/079). UI atvaizdavimas (065).
