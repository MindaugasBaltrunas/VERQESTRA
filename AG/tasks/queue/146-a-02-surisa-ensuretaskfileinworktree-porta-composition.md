# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 146-a — `ensureTaskFileInWorktree` porto kontraktas `slot-task-runner.ts` (privaloma pirma)
- 133-run-budget-semantika-run-pjuvis-arba-lifetime-vardas (bendras `command.ts`)

## Tikslas
Surišti `slot-task-runner.ts` deklaruotą `ensureTaskFileInWorktree` portą composition
sluoksnyje, kad vaiko paleidimo vartas turėtų realią FS realizaciją: patikrinti, ar
`<worktreeAbs>/<slot.file>` egzistuoja worktree kopijoje, ir pagal ankstesniame task'e
priimtą architekto verdiktą arba atkurti failą iš `slot.absoluteFile`, arba grąžinti
neigiamą rezultatą su aiškia priežastimi. Operatorius iš žurnalo turi matyti, kad
FS↔git lenktynės įvyko ir buvo uždarytos.
Jei `command.ts` portas jau surištas — ALREADY_IMPLEMENTED su kodo citata.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/command.ts`
- `src/tests/composition-loop-command.test.ts`

Draudžiama:
- `src/application/scheduling/slot-task-runner.ts`
- `src/tests/scheduling-slot-task-runner.test.ts`
- `src/application/scheduling/worker-integration.ts`
- `src/application/scheduling/wave-provisioning.ts`
- `src/infrastructure/git/worktrees/worktree-provision.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `command.ts` slot runner ports objekte (šalia `runChild` ~259 eil. ir `prepareWorktree`
  ~312 eil.) pridėti `ensureTaskFileInWorktree` realizaciją: `<worktreeAbs>/<slot.file>`
  egzistavimo patikra per esamą fs portą, be naujų priklausomybių.
- Verdikto (a) atveju — kopija iš `slot.absoluteFile` su `deps.log` eilute esamu stiliumi;
  klaidos ryja į neigiamą rezultatą + žurnalą, jokio metimo į iškvietėją.
- `composition-loop-command.test.ts`: portas surištas ir grąžina teisingą rezultatą, kai
  failas worktree yra ir kai jo nėra.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei paaiškėja, kad reikia keisti
`worker-integration.ts` baigties semantiką arba `wave-provisioning.ts` — tai 113 ir 116
queue task'ų scope, ne šio.

## Neįtraukta
- Porto kontrakto ar varto vietos keitimas `slot-task-runner.ts`.
- `child-exit-diagnostics.ts` exit 74 diagnostikos gerinimas.
- Task 145 grąžinimas iš human-review — operatoriaus veiksmas.
