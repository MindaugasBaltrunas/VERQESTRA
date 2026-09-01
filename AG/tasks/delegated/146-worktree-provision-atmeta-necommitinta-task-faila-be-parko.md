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

## Tikslas
Uždaryti FS↔git lenktynes vaiko paleidimo vartuose: planuoklė pačiumpa task failą iš
disko (`AG/tasks/queue`), o provision kuria worktree iš git HEAD (`baseRef: "HEAD"`),
kuriame to commit'o dar nėra — vaikas miršta ENOENT/exit 74 ir task'as parkuojamas į
human-review kaip `task-failed`, nors task'as niekuo dėtas.
Šiame darbe: application pusė — porto kontraktas ir vartas PRIEŠ `runChild`.
Invariantas: dėl šios priežasties NIEKADA neparkuoti į human-review.
Jei `slot-task-runner.ts` (šiandien 144-156 eil.: `runInProcess` / `verifyOwnership` →
`prepareWorktree` → `runChild`) toks vartas jau yra — ALREADY_IMPLEMENTED su kodo citata.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/slot-task-runner.ts`
- `src/tests/scheduling-slot-task-runner.test.ts`

Draudžiama:
- `src/composition/loop/command.ts`
- `src/application/scheduling/worker-integration.ts`
- `src/application/scheduling/wave-provisioning.ts`
- `src/infrastructure/git/worktrees/worktree-provision.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- architect: verdiktas (a) deterministinis atkūrimas (kopija iš `slot.absoluteFile`) ar
  (b) atidėjimas be `task-failed`, su pagrindimu ataskaitoje; (a) atveju kodu patikrinti,
  ar untracked task failas nekerta vaiko švaraus medžio vartų (`nonRuntimeDirtyPaths`).
- `SlotTaskRunnerPorts`: naujas OPCIONALUS portas
  `ensureTaskFileInWorktree?(slot, worktreeAbs)`, kviečiamas TIK worktree šakoje po
  `verifyOwnership`, prieš `runChild`; nesėkmė — įvardinta `WAVE SLOT ...` žurnalo
  eilutė esamu stiliumi, ne metimas. Opcionalus todėl, kad surišimas ateina kitu task'u
  ir in-process kelias porto nekviečia.
- `scheduling-slot-task-runner.test.ts`: (1) portas praneša „yra“ → vaikas paleidžiamas
  kaip iki šiol; (2) failo nėra → pasirinktos šakos elgesys ir jokio `task-failed` kelio;
  (3) in-process slot'as porto nekviečia.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei architekto verdiktas (b):
švarus atidėjimas be `task-failed` parko reikalauja `worker-integration.ts` /
`wave-provisioning.ts` pakeitimų, kurie kerta 113 ir 116 queue task'ų scope — tada šio
task'o apimtis lieka verdikto dokumentavimas Leidžiamuose failuose.

## Neįtraukta
- Porto realizacija ir surišimas `command.ts` — sekantis task'as.
- `child-exit-diagnostics.ts` exit 74 diagnostikos gerinimas.
- Task 145 grąžinimas iš human-review — operatoriaus veiksmas.
