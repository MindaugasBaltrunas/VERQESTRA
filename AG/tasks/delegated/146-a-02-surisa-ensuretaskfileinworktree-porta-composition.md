## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 146-worktree-provision-atmeta-necommitinta-task-faila-be-parko (porto kontraktas `slot-task-runner.ts` — privaloma pirma; 2026-09-02 pataisyta iš neegzistuojančio id „146-a", kuris planuoklei būtų amžinai neišsprendžiama nuoroda)
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
