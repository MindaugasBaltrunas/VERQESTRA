## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
- `openspec/changes/auto-037-task-numeris-vienareiksmis-per-visa-gyvavimo-c/` (spec.md, design.md)
- `src/domain/tasks/identity.ts` (`taskNumberFromFilename`, `splitChildParentStemCandidates`)

## Tikslas
Task'o šaknies numeris privalo žymėti VIENĄ task šeimą per visus `AG/tasks/*` bucket'us. Reikia pure funkcijos, sudarančios žemėlapį `numeris → šeimos`, ir vartų testo, kuris naujų kolizijų neleidžia, o keturias istorines (029, 030, 031, 032) laiko eksplicitiniame KNOWN sąraše.

## Agentai
Privaloma grandinė: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/number-family.ts`
- `src/domain/tasks/index.ts`
- `src/tests/task-number-uniqueness.test.ts`

Draudžiama:
- `AG/tasks/**`
- `src/infrastructure/**`
- `src/application/**`
- `vq/**`
- `.env`

## Veiksmas
- Sukurti pure funkciją `src/domain/tasks/number-family.ts`: įvestis — task failų vardų sąrašas (JOKIO `node:` importo, jokio fs), išvestis — `numeris → šeimų bazių sąrašas`; split vaikai priskiriami tėvo šeimai per `splitChildParentStemCandidates`; eksportuoti per `src/domain/tasks/index.ts`.
- Parašyti `src/tests/task-number-uniqueness.test.ts`: nuskaito visus `AG/tasks/*` bucket'us (`queue`, `active`, `delegated`, `error`, `failed`, `human-review`, `done`), sudaro žemėlapį ir lygina su statiniu KNOWN sąrašu (numeris + abiejų pusių failo vardai + priežastis „audit 2026-08-26"); KNOWN įrašus užpildyti REALIU disko turiniu, nespėlioti.
- Prikalti abi kryptis: nauja ne-KNOWN kolizija → raudona; KNOWN įrašas, kurio kolizijos diske nebėra → taip pat raudona. Pridėti unit testus pačiai funkcijai su sintetiniais vardais (unikalus numeris, split šeima, kolizija).

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei: funkcijai prireiktų `node:` importo `domain` sluoksnyje; KNOWN sąrašas išeitų didesnis nei keturios kolizijos (tai reikštų kitokį radinį nei auditas); reikėtų pervadinti ar keisti bet kurį `AG/tasks/**` failą.

## Neįtraukta
- `taskWorkEvidenceGrepArgs` `numberIsUnique` parametras (atskira užduotis).
- `taskGenerate` skyrimo lenktynių pertikrinimas ir `enqueue-child-tasks.ts` komentaras (atskira užduotis).
- Esamų task failų pervadinimas ar istorijos taisymas.
