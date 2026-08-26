# Task

## Spec source
- `openspec/changes/verqestra-backlog-v1`
- `docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md` (skyrius „R4")

## Tikslas
Tėvo auto-change'as neturi būti archyvuojamas, kol tą patį slug'ą savo `## Spec source` cituoja
bent vienas task'as neterminaliuose bucket'uose (`queue`, `active`, `delegated`, `human-review`).
Dabar archyvavimas paverčia savo paties skaidymo vaikus nedispatch'inamais: preflight'as jų
nuorodą pamato kaip archyvinę ir atmeta.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/task-execution/openspec-archive.ts`
- `src/application/task-execution/openspec-reconcile.ts`
- `src/tests/task-execution-support.test.ts`

Draudžiama:
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts`
- `src/tests/interfaces-cli-preflight.test.ts`
- `.env`
- `node_modules/**`

## Veiksmas
- Perkelk `listFiles(absoluteDir): Promise<string[]>` iš `OpenSpecReconcileFsPort`
  (`openspec-reconcile.ts:26-31`) į `OpenSpecArchiveFsPort` (`openspec-archive.ts:19-27`); naujo
  porto NEKURK. Composition jau tiekia `openSpecReconcileFs`, tad ten keisti nieko nereikia;
  fake'ą `task-execution-support.test.ts:202` papildyk.
- `archiveAutoOpenSpecChangeOnDone`: prieš `rename` suskaičiuok, ar slug'ą cituoja kuris nors
  `AG/tasks/{queue,active,delegated,human-review}/*.md` failas — nuorodų paiešką daryk esamu
  `extractAutoChangeSlugs` (`openspec-archive.ts:57`), ne nauja regex. Jei taip — negrąžink
  `archived`: pridėk `OpenSpecArchiveOutcome` variantą `{ action: "deferred-children", changeDir,
  citedBy: string[] }`, palik change'ą aktyvų ir nežymėk `tasks.md`.
- Testai `task-execution-support.test.ts`: (1) slug'ą cituoja `queue` task'as → change lieka
  aktyvus, baigtis `deferred-children`, `renames` tuščias; (2) niekas nebecituoja → baigtis
  `archived` byte-for-byte tokia pat kaip anksčiau; (3) `reconcileAutoOpenSpecChanges` batch kelias
  paveldi tą pačią taisyklę, o ne ją apeina.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok nedelsiant, jei sprendimas imtų reikšti preflight'o
archyvinės nuorodos taisyklės keitimą (`interfaces-cli-preflight.test.ts:315-319` ją užrakina —
jos silpninimas būtų testo, o ne klaidos taisymas) arba `resolveAutoChangeForTask` prefikso
skenavimą (`openspec-archive.ts:111-114` atmestas sąmoningai).

## Neįtraukta
- Jau užstrigusių vaikų atrakinimas — atskiras operatoriaus veiksmas.
- `slugFromTask` taisyklių keitimas ir skaidymo kelias, kuris vaikams parenka `## Spec source`.
