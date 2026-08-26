# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md (skyrius „R4")

## Tikslas
Tėvo auto-change'as neturi būti archyvuojamas, kol jį dar cituoja neužbaigtas task'as. Šiuo metu
archyvavimas paverčia savo paties skaidymo vaikus nedispatch'inamais: preflight'as jų `## Spec
source` nuorodą pamato kaip archyvinę ir atmeta.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/openspec-archive.ts`
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/tests/task-execution-support.test.ts`

Draudžiama:
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts` (archyvinės nuorodos taisyklė NEKEIČIAMA)
- `src/tests/interfaces-cli-preflight.test.ts`
- `.env`
- `node_modules/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI (2026-08-26): `AG/openspec/changes/archive/auto-037-task-numeris-vienareiksmis-per-visa-gyvavimo-c`
  egzistuoja, o to paties vardo aktyvaus katalogo nėra. Du vaikai, `037-a-02-…` ir `037-b-03-…`,
  savo `## Spec source` cituoja nearchyvinį kelią, todėl `orchestrator.log:6264,6270` abiem grąžino
  `Invalid OpenSpec reference: … does not exist` ir `preflight_failed=1`. Nė vienas nebuvo
  dispatch'intas.
- Seka: `slugFromTask` (`application/task-planning/openspec-slug.ts:21-33`) sukūrė tėvo change'ą →
  skaidymas tą patį slug'ą įrašė vaikams → tėvas 037 baigė `done` →
  `archiveAutoOpenSpecChangeOnDone` (`openspec-archive.ts:148`) change'ą perkėlė į archyvą.
  Sistema pati padarė savo vaikus nepaleidžiamais.
- SPRENDIMO KRYPTIS: prieš perkeliant, patikrinti, ar tą patį slug'ą cituoja bent vienas task'as
  neterminaliuose bucket'uose (`queue`, `active`, `delegated`, `human-review`). Jei taip —
  NEARCHYVUOTI ir grąžinti atskirą baigtį (pvz. `deferred-children`) su garsia žurnalo eilute.
  Nuorodų paiešką daryti esamu `extractAutoChangeSlugs` (`openspec-archive.ts:61`), ne nauja regex.
- RIBA, KURI NEKEIČIAMA: preflight'o taisyklė „archyvinė nuoroda yra negaliojanti" lieka kaip yra.
  Ją užrakina `src/tests/interfaces-cli-preflight.test.ts:315-319`; jos silpninimas būtų testo, o
  ne klaidos taisymas. Sprendžiama archyvavimo TVARKA, ne nuorodos galiojimas.
- Portas: `OpenSpecArchiveFsPort` šiuo metu turi tik `exists`. Task'ų failų sąrašui reikės
  skaitymo galimybės — ji pridedama prie to paties porto, o adapteris surišamas
  `coordinator-execution-adapters.ts:234` kvietime. Naujo porto NEKURTI.
- Testai (`task-execution-support.test.ts`): (1) slug'ą cituoja `queue` task'as → change lieka
  aktyvus, baigtis `deferred-children`; (2) niekas nebecituoja → archyvuojama kaip anksčiau,
  byte-for-byte ta pati baigtis; (3) `openspec-reconcile.ts` batch kelias paveldi tą pačią
  taisyklę, o ne apeina ją.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok nedelsiant, jei sprendimas imtų reikšti preflight'o
archyvinės nuorodos taisyklės keitimą arba `resolveAutoChangeForTask` prefikso skenavimą —
pastarasis `openspec-archive.ts:111-114` atmestas sąmoningai ir ta priežastis tebegalioja.

## Neįtraukta
- Jau užstrigusių `037-a-02` ir `037-b-03` atrakinimas (atskiras operatoriaus veiksmas).
- `slugFromTask` taisyklių keitimas.
- Skaidymo kelias, kuris vaikams parenka `## Spec source`.
