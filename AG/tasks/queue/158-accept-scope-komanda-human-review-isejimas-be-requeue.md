# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/cli/commands-tasks.ts` registruoja komandą `accept-scope`, egzistuoja
`src/interfaces/cli/task-queue/accept-scope.ts` ir README „Task queue" lentelė turi jos eilutę —
ALREADY_IMPLEMENTED: cituok registro įrašą, README eilutę ir `composition-cli.test.ts` komandų
sąrašo įrašą.

## Tikslas
Human-review bucket'as turi vieną išėjimą — `requeue` — ir jis netinka dažniausiai klasei:
`rollback_failed` 34 iš 69 parkų per 13 dienų (`orchestrator.log`), 5 iš 5 parkų 2026-09-03
(137, 142, 101 ×2, 155). Tai „darbas padarytas, užcommit'intas, žalias, bet vienas kelias nebuvo
`## Failai` sąraše" — pvz. 155 (19:18): `changed files outside allowed paths:
src/tests/context-pack-assemble.test.ts`, viena pašalinta assert eilutė. `requeue` perdarytų
darbą (preflight + dispatch už `ALREADY_IMPLEMENTED`); teisingas veiksmas šiandien yra 3–4
rankiniai žingsniai dviem žmonėms: pataisyti `## Failai` tekstą (anotacija VIRŠ `Leidžiama:`,
kelias sąraše), `git merge` išsaugotą šaką, `task-move` į `done`. Komanda `verqestra
accept-scope <task> <path…>` padaro tekstinę ir bucket'o dalį vienu žingsniu; merge lieka
operatoriui (git mutacijos — ne CLI adapterio darbas), bet komanda išspausdina tikslią eilutę.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester -> documenter

## Failai
Leidžiama:
- `src/domain/tasks/failai-scope-edit.ts` (numatomas naujas — grynas `## Failai` redaktorius)
- `src/tests/domain-tasks-failai-scope-edit.test.ts` (numatomas naujas)
- `src/interfaces/cli/task-queue/accept-scope.ts` (numatomas naujas; šablonas — `requeue.ts`)
- `src/tests/interfaces-cli-task-queue.test.ts`
- `src/composition/cli/commands-tasks.ts`
- `src/tests/composition-cli.test.ts` (komandų sąrašas 164-199 eil.)
- `README.md` (tik „Task queue" lentelės eilutė — `readiness-audit` tikrina README ↔ registrą)

Draudžiama:
- `src/interfaces/cli/task-queue/requeue.ts`
- `src/interfaces/cli/task-queue/task-move.ts`
- `src/application/task-execution/bucket-transition.ts` (naudojamas `moveTaskToBucket`, nekeičiamas)
- `src/domain/tasks/allowed-paths.ts`
- `src/domain/tasks/etalonas-rules.ts` (156/157 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `failai-scope-edit.ts`: gryna `acceptScopePaths(markdown, paths, note)` → naujas markdown:
  datuota `> ` pastaba įterpiama tuoj po `## Failai` antraštės (PRIEŠ `Leidžiama:` — parseris
  `allowed-paths.ts:50-57` jos ten nemato), kelias(-iai) pridedami `Leidžiama:` sąrašo gale kaip
  `- \`kelias\``; idempotentiška (esamas kelias nekartojamas); be `## Failai` — `err`.
- `accept-scope.ts` pagal `requeue.ts` formą: deps `store`, `readTextFile`, `writeTextFile`,
  `isFile`, `projectRoot`, `io`; usage → 2; šaltinis TIK `AG/tasks/human-review/<name>.md`; kelias
  privalo egzistuoti projekte (kitaip 2 — priimamas realus failas, ne rašybos klaida); po
  redagavimo `moveTaskToBucket(store, agRoot, source, "done", name, { updateCurrent: false })`;
  išvestis: `accepted: <name> paths=<n>` + `merge hint: git merge --no-ff <šaka>`, jei šakos vardas
  žinomas iš ledger'io/lease'o; kitaip praleisti — ne spėti.
- `commands-tasks.ts`: registro įrašas `accept-scope <task-file-or-name> <path…>` su aprašu,
  fs portai — kaip gretimų komandų (`nodeFsAdapter`).
- `README.md` „Task queue" lentelė: eilutė po `requeue`. `composition-cli.test.ts` sąrašas
  papildomas `"accept-scope"` po `"requeue"`.
- Testai: domain — pastaba virš `Leidžiama:`, kelias sąrašo gale, idempotentiškumas, be sekcijos
  `err`, rezultatas praeina `validateTaskAgainstEtalonas`; CLI — usage 2, ne human-review 2,
  neegzistuojantis kelias 2, sėkmė → failas `done` bucket'e su pakeistu tekstu ir `accepted:` eilute.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei šakos vardo šaltinis reikalautų naujo
porto ar lease store skaitymo iš CLI — tada „merge hint" lieka be šakos, o ne plečia kontraktą.

## Neįtraukta
- Šakos merge iš CLI (git mutacija; dabar loop'o integracijos ir operatoriaus darbas).
- Politikos pakeitimas „testo failas už ribos → done automatiškai" — operatoriaus sprendimas
  po savaitės duomenų su 156/157/158.
- UI mygtukas human-review panelėje (`HumanReviewPanel`) — atskiras UI task'as po CLI.
