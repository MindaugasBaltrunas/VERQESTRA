# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/task-execution/run-coordinator-terminal.ts`
`applyTerminal` kelias (dabar 74-119 eil.) valo `vq/state/current-task-file`
žymę, kai ji rodo į ką tik terminalą pasiekusį task'ą (per portą, surištą
kompozicijoje) — ALREADY_IMPLEMENTED: cituok valymo kodą, porto surišimą ir
testą kaip įrodymą.

## Tikslas
Audito P1 su GYVU incidentu (2026-09-01): `current-task-file` žymė turi DU
rašytojus ir NĖ VIENO valytojo — Grep per visą src patvirtina: rašo
`infrastructure/state/task-state-store.ts:269` ir
`composition/loop/coordinator-adapters.ts:275` (abu AKTYVUOJANT task'ą),
trynimo kelio nėra niekur. Skaitytojai gyvi:
`interfaces/hooks/on-stop-context.ts:180` (Stop staging SCOPE — svarbiausias),
`ui-dashboard-view.ts:317`, `cli/admin/status.ts:121`,
`cli/github/pull-request.ts:136` (commit WIP žyma). Incidentas: 015-a-02
baigėsi 06:07, žymė liko rodyti į jį → orkestratoriaus `.gitignore` rašymas
stop hook'uose gavo „Produkto pakeitimų nėra" (mirusio task'o scope filtras
išmetė svetimą failą) → loop stojo `dirty product tree`, o commit'ai iki
09:17 žymėti mirusio task'o vardu. Sprendimo kryptis: terminalinis bucket
perėjimas valo žymę — inkaras yra `applyTerminal`
(`run-coordinator-terminal.ts:74-79` doc'as: „VIENINTELĖ vieta, taikanti
terminalinį perėjimą"), valymas sąlyginis (tik kai žymė rodo į šį task'ą —
svetima žymė nepaliečiama, nes lygiagretus slot'as galėjo ją perrašyti).
KARTU (tas pats modulis, mikro-punktas iš audito F5): `verify-task.ts:163-164`
komentaras „kol kompozicijos adapteris (095-a-03) jo neturi" PASENĘS —
adapteris egzistuoja ir pin'intas `composition-cli.test.ts:220-242`;
atnaujinti komentarą pagal realybę (kodo elgesys nekinta).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/run-coordinator-terminal.ts`
- `src/application/task-execution/run-coordinator-ports.ts` (jei valymui
  reikia naujo porto metodo)
- `src/infrastructure/state/task-state-store.ts` (valymo funkcija šalia
  rašytojo, 269 eil. kontekstas)
- `src/composition/loop/coordinator-adapters.ts` (porto surišimas)
- `src/application/task-execution/verify-task.ts` (TIK 163-164 eil.
  komentaro atnaujinimas — elgesys nekinta, testų keisti nereikia)
- `src/tests/task-execution-coordinator.test.ts` (terminalo kelio testai;
  jei applyTerminal dengiamas kitame task-execution teste — tas failas
  vietoje šio, įrašyti į ataskaitą)
- `src/tests/infrastructure-task-state-store.test.ts` (valymo funkcijos
  testai)

Draudžiama:
- `src/application/task-execution/bucket-transition.ts` ir
  `src/tests/task-execution-bucket-transition.test.ts` (task 124 scope —
  sąmoningai apeita per applyTerminal inkarą)
- `src/interfaces/hooks/on-stop-context.ts` (skaitytojas teisingas — jam
  tiesiog nebeliks stalios žymės)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `task-state-store.ts`: funkcija, kuri IŠVALO `vq/state/current-task-file`
  TIK jei jos turinys rodo į nurodytą task failą (compare-and-clear —
  besąlyginis trynimas ištrintų lygiagretaus slot'o ką tik įrašytą žymę).
- `run-coordinator-terminal.ts` (`applyTerminal`): po sėkmingo terminalinio
  perėjimo kviesti valymą per portą; valymo klaida — log eilutė, ne
  perėjimo lūžis (žymė yra patogumo veidrodis, ne tiesos šaltinis).
- `coordinator-adapters.ts`: porto surišimas su nauja store funkcija.
- `verify-task.ts` 163-164 eil.: komentaras atnaujinamas — adapteris yra,
  optional lieka dėl kontrakto suderinamumo (arba kaip vykdytojas
  suformuluos pagal realybę).
- Testų lūkestis: (1) regresija — task'ui pasiekus done/human-review, žymė
  su jo keliu išvaloma; (2) žymė su SVETIMU keliu nepaliečiama;
  (3) valymo klaida nesulaužo terminalinio perėjimo; (4) esami
  applyTerminal testai žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad
compare-and-clear neužtenka (pvz. žymė rašoma dar viename kelyje, kurio
Grep nerado) — tada valymo vietų sąrašas yra dizaino klausimas.

## Neįtraukta
- `on-stop-context.ts` staging scope logika — skaitytojas elgiasi teisingai
  su teisinga žyme.
- Retroaktyvus 06:07-09:17 commit'ų žymų taisymas — istorija nekeičiama.
- `ui-dashboard-view` / `status` / `pull-request` skaitytojų elgesys su
  tuščia žyme — jie jau moka `null` kelią.
