# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 133-run-budget-semantika-run-pjuvis-arba-lifetime-vardas

> Reali failų sankirta: `src/composition/loop/command.ts` deklaruotas 133
> Leidžiamoje ((A) šakos sąlyginis kelias) — be priklausomybės planuoklė porą
> vis tiek serializuotų su wildcard/persidengimo spraga.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/slot-task-runner.ts` prieš `runChild`
(šiandien 142-156 eil.: `verifyOwnership` → `prepareWorktree` → `runChild`,
jokios task failo patikros) turi vartą, kuris patikrina, kad `slot.file`
egzistuoja worktree kopijoje, ir nesant failo arba deterministiškai jį
atkuria, arba atideda slot'ą be `task-failed` parko —
ALREADY_IMPLEMENTED: cituok patikros kodą ir jos portą `command.ts`
surišime kaip įrodymą.

## Tikslas
FS↔git lenktynės su gyvu įrodymu (orchestrator.log 2026-09-01 19:26): task
145 failas egzistavo `AG/tasks/queue` DISKE, planuoklė jį pačiupo, o
provision sukūrė worktree iš git HEAD (`wave-scheduler-adapters.ts:122` —
`baseRef: "HEAD"`), kuriame failo commit'o dar nebuvo. Vaikas paleistas su
reliatyviu keliu (`command.ts` `runChild` — vaikas resolve'ina prieš SAVO
cwd) mirė `process-queued-task: ENOENT ... <worktree>\AG\tasks\queue\145-...md`,
exit 74 per 12 s, ir `worker-integration.ts` (245-253, 292-299 eil.)
parkavo task'ą į human-review kaip `task-failed` — nors task'as niekuo
dėtas: klaida yra provision kelio, ne task'o.

Sprendimo kryptis: PRIEŠ vaiko paleidimą patikrinti, ar task failas yra
worktree kopijoje; jei ne — viena iš dviejų šakų (verdiktas ARCHITEKTO,
abi su trade-off'ais žemiau):
- (a) DETERMINISTINIS ATKŪRIMAS: nukopijuoti task failą iš pagrindinio
  medžio (`slot.absoluteFile` jau yra slot kontrakte) į
  `<worktreeAbs>/<slot.file>`. Pliusai: vaikas visada gauna tą failą, kurį
  planuoklė realiai matė; ciklas nešvaisto slot'o. Rizika: kopijoje
  atsiranda untracked AG failas — architektas privalo patikrinti, kad
  vaiko švaraus medžio vartai (`nonRuntimeDirtyPaths` klasė) dėl jo
  nekristų (vaikas pats perkelia queue→active ir commitina, bet tai reikia
  patvirtinti kodu, ne prielaida).
- (b) ATIDĖJIMAS: slot'as šiam ciklui praleidžiamas su aiškia SKIP
  priežastimi (pvz. `task-file-not-in-head`), task'as lieka queue ir bus
  pačiuptas, kai commit'as atsiras. Pliusai: jokios worktree mutacijos.
  Kaina: SKIP negali eiti per esamą `runChild=false` kelią — nesėkmingas
  worktree slot'as tampa `FinishedWorkerSlot.succeeded=false` ir
  `worker-integration.ts` jį parkuoja `task-failed`; švarus (b) reikalauja
  slot baigties praturtinimo arba provision-lygio swap'o, o tai kerta 113
  (`scheduling-pool.test.ts`) ir 116 (`wave-provisioning.ts`) scope — žr.
  Stop.

NIEKADA neparkuoti į human-review dėl šios priežasties — tai invariantas
abiem šakoms.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/slot-task-runner.ts` (vartas prieš
  `runChild`; naujas portas `SlotTaskRunnerPorts` kontrakte)
- `src/composition/loop/command.ts` (porto surišimas — FS
  patikra/kopijavimas ir žurnalo eilutė; bendras su 133, žr.
  Priklausomybės)
- `src/tests/scheduling-slot-task-runner.test.ts` (egzistuoja — vartų
  elgesio testai su fake portu)
- `src/tests/composition-loop-child-exit.test.ts` (numatomas surišimo
  patikrai; jei wiring testas gyvena kitur — tas failas vietoje šio,
  įrašyti į ataskaitą)

Draudžiama:
- `src/application/scheduling/wave-provisioning.ts` ir
  `src/tests/scheduling-wave-provisioning.test.ts` (116 queue scope)
- `src/application/scheduling/worker-integration.ts` ir
  `src/tests/scheduling-pool.test.ts` (park semantika — 113 queue scope
  testo pusėje; jos keitimas = Stop, ne tylus scope plėtimas)
- `src/infrastructure/git/worktrees/worktree-provision.ts` (git kūrimo
  mechanika ir `baseRef: "HEAD"` nekinta — sprendžiama vaiko paleidimo
  vartuose, ne git sluoksnyje)
- `dist/**`
- `node_modules/**`

## Veiksmas
- ŽINGSNIS 1 (architect, PRIEŠ kodavimą): verdiktas (a) ar (b) su
  pagrindimu ataskaitoje. (a) atveju privaloma kodu patikrinti untracked
  task failo poveikį vaiko švaraus medžio vartams; (b) atveju — žr. Stop,
  nes švari realizacija išeina už šio task'o Leidžiamos.
- `slot-task-runner.ts`: naujas portas (pvz.
  `ensureTaskFileInWorktree(slot, worktreeAbs)`), kviečiamas worktree
  šakoje PO `verifyOwnership`, PRIEŠ `runChild` (ar prieš/po
  `prepareWorktree` — architekto sprendimas su pagrindimu). Nesėkmė —
  įvardinta `WAVE SLOT ...` žurnalo eilutė esamu stiliumi, ne metimas.
- `command.ts`: porto realizacija — `<worktreeAbs>/<slot.file>`
  egzistavimo patikra; (a) šakoje kopija iš `slot.absoluteFile` su žurnalo
  eilute, iš kurios operatorius mato, kad lenktynės įvyko ir buvo
  uždarytos.
- Testų lūkestis (`scheduling-slot-task-runner.test.ts`): (1) failas
  worktree yra → vaikas paleidžiamas kaip iki šiol, portas nieko nekeičia;
  (2) failo nėra → pasirinktos šakos elgesys: (a) nukopijuota ir vaikas
  paleistas, (b) vaikas NEpaleistas ir baigtis NĖRA `task-failed` parko
  kelias; (3) porto klaida ne-worktree (pirminiame) slot'e neįmanoma —
  in-process kelias porto nekviečia.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei architekto verdiktas
yra (b): švarus atidėjimas be `task-failed` parko reikalauja
`worker-integration.ts`/`wave-provisioning.ts` pakeitimų, kurie kerta 113
ir 116 queue task'ų scope — tada šio task'o apimtis apsiriboja verdikto
dokumentavimu, o realizacijai kuriamas atskiras task'as su suderintomis
priklausomybėmis.

## Neįtraukta
- Exit 74 (ENOENT) diagnostikos gerinimas `child-exit-diagnostics.ts` —
  prevencija svarbiau už gražesnę autopsiją; jei po šio task'o klasė
  pasikartos, diagnostika bus atskiras task'as.
- Task 145 grąžinimas iš human-review į queue — bucket'ų kilnojimas yra
  operatoriaus veiksmas, ne šio task'o.
- `worker-integration.ts` park semantikos keitimas (žr. Stop) ir
  `wave-provisioning.ts` provision-metu swap'as — 113/116 scope.
- FS↔git lenktynių šaknis (planuoklė skaito diską, provision — HEAD)
  apskritai: sinchronizuoti planuoklės įvestį su HEAD būtų platus elgesio
  pakeitimas visai eilei; šis task'as uždaro konkretų žalos kelią.
