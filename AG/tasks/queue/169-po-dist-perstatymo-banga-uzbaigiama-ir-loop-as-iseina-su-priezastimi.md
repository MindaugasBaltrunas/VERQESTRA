# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 167-worktree-vaiko-runtime-busena-surenkama-ir-uzsejama-per-task-a
- 168-vienas-koordinatoriaus-portu-fabrikas-visiems-trims-iejimams

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/loop-cycle.ts` `LoopCycleOutcome` turi baigtį po dist perstatymo
(pvz. `restart-required`/`dist-rebuilt`), `runLoopCycle` ją grąžina tarp task'ų, o
`src/composition/loop/command.ts` `runLoopCommand` ją atvaizduoja į `DIST_STALE_EXIT_CODE` su
žurnalo eilute — ALREADY_IMPLEMENTED: cituok baigtį, tikrinimo vietą ir exit atvaizdį.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, L8; pilna ataskaita
`audit-composition.md` P1-5): po `rebuildDist` bangos viduryje tėvas suka seną kodą, vaikai — naują.
`wave-integration-adapters.ts:177-185` perstato `dist` projekto šaknyje po `src` integracijos
(`wave-integration-step.ts:63-85`, `INTEGRATION DIST REBUILT`); `application/scheduling` neturi
jokio restart/stop signalo po to (grep `rebuil|restart` — nieko). Toliau planuoklis ir in-process
w1 koordinatorius yra senas kodas atmintyje, o `cliEntryPath()` vaikai (`command.ts:274`;
`coordinator-adapters.ts:397` — claude-preflight/dispatch/diagnose/quality-gates) jau naujas dist:
vieno task'o viduje koordinatorius (senas) kalba su dispatch'u (nauju). `command.ts:12-13` antraštė
teigia priešingai („vaikas per TĄ PAČIĄ CLI... kitaip kopija dirbtų su kito build'o semantika");
įspėjimo operatoriui nėra — žinoma tik iš atminties („po src integracijos loop'ą būtina
perstartuoti", 2026-09-02). Susijęs P2 (`audit-loop-core.md`): `loop-cycle.ts:126-135` resume
kilpa be bandymų ribos — tas pats task'as, grąžinantis nenulį, kartojamas be galo.

Kryptis (audito santrauka L8): po `rebuildDist` planuoklis baigia bangą (visi gyvi slot'ai
integruojami kaip įprasta) ir loop'as išeina su aiškia priežastimi. Pasirinktas išėjimas, ne
restartas savyje: Node modulių neperkrauna, o supervizoriaus/UI restartas yra atskiras sprendimas
po aiškaus exit kodo. Exit kodas — `DIST_STALE_EXIT_CODE` (78): ta pati semantika kaip 164 starte
(„vykdomas kodas nebeatitinka dist"). Priklausomybės: 167 (`wave-integration-adapters.ts`) ir 168
(`command.ts`).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/loop-cycle.ts` (`LoopCyclePorts`, `LoopCycleOutcome` 95-97, ciklas 118-154)
- `src/composition/loop/wave-integration-adapters.ts` (`rebuildDist` 177-185 — perstatymo žymė)
- `src/composition/loop/command.ts` (antraštė 12-13, `buildLoopCyclePorts` naujas portas, `runLoopCommand` 490-500 exit atvaizdis, EXIT KONTRAKTO komentaras 413-427)
- `src/tests/scheduling-loop-cycle.test.ts`
- `src/tests/composition-loop-command.test.ts`
- `src/tests/composition-wave-integration-adapters.test.ts`

Draudžiama:
- `src/application/scheduling/wave-integration-step.ts` (`INTEGRATION DIST REBUILT` žurnalas nekinta)
- `src/application/scheduling/wave-integration-ports.ts` (kontraktas nekinta — žymė gyvena adapteryje)
- `src/application/scheduling/wave-scheduler.ts` (166 scope)
- `src/shared/exit-codes.ts` (78 jau apibrėžtas)
- `src/interfaces/http/loop-lifecycle.ts` (UI reakcija į 78 — ne šis task'as)
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `wave-integration-adapters.ts` `rebuildDist`: sėkmingas perstatymas pažymimas adapterio būsenoje
  (`distRebuiltAt: string | undefined`), eksponuojama `distRebuilt(): boolean` greta kitų adapterių
  (grąžinamo objekto tipas praplečiamas; `WaveIntegrationPorts` kontraktas neliečiamas).
- `loop-cycle.ts`: `LoopCyclePorts.distRebuilt(): boolean`; tikrinama tarp task'ų (prieš
  `selectNextResumableTask`, 126) → `{ kind: "restart-required", reason: "dist-rebuilt" }` su
  žurnalu `LOOP EXIT: dist rebuilt during run (task=<paskutinis integruotas>) — planner runs stale
  code; restart the loop`. Kadangi tikrinama tik tarp task'ų, banga su gyvais slot'ais baigiama ir
  integruojama kaip iki šiol. Resume kilpa (126-135): riba to paties failo kartojimams
  (`MAX_RESUME_ATTEMPTS_PER_RUN`, pvz. 3) — viršijus, žurnalas `RESUME LIMIT REACHED: file=…` ir
  ciklas eina prie eilės, ne sukasi.
- `command.ts`: `buildLoopCyclePorts` suriša `distRebuilt: () => integrationAdapters.distRebuilt()`;
  `runLoopCommand` → `restart-required` → `DIST_STALE_EXIT_CODE`; antraštė 12-13 ir EXIT KONTRAKTO
  komentaras 413-427 papildomi 78 („dist perstatytas bėgimo metu — restartuoti").
- Testai: `scheduling-loop-cycle.test.ts` — po task'o su `distRebuilt=true` ciklas grąžina
  `restart-required` ir nepradeda kito task'o; resume riba; `composition-loop-command.test.ts` —
  `restart-required` → 78; `composition-wave-integration-adapters.test.ts` — žymė po sėkmingo
  `rebuildDist`, ne po nesėkmingo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei UI/supervisor kelias (`loop-lifecycle`,
`vq/supervisor`) exit 78 traktuoja kaip klaidą ir neperstartuoja — tada automatinis restartas yra
operatoriaus politika, o šis task'as palieka tik signalą.

## Neįtraukta
- Automatinis loop'o restartas po 78 (supervisor/UI) — atskiras sprendimas po šio signalo duomenų.
- Karštas modulių perkrovimas planuoklyje — atmesta (Node semantika).
- `loop` starto prielaidos ir 78 startuojant — task 164.
- README exit kodų lentelė — dokumentacijos autorius.
