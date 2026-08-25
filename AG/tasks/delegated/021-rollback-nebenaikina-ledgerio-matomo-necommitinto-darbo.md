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
openspec/changes/verqestra-backlog-v1/
docs/audits/020-session-writes-ledger-diagnosis-2026-08-25.md (režimas R2, įrodymas A)

## Tikslas
Užfiksuoti architect sprendimą R2 spragai: kai Stop hook'o commit'as nespėja iki dispatch pabaigos, task-scoped rollback'as sunaikina ledger'io matomą necommit'intą darbą (018: „restored 2 task path(s)", patikros buvo žalios). Šis darbas — TIK sprendimo dokumentas su kontraktu, be produkcinio kodo.

## Agentai
readme-guard -> architect

## Failai
Leidžiama:
- `docs/audits/021-rollback-preserve-design-2026-08-25.md`

Draudžiama:
- `src/**`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Aprašyk 018 įrodymų seką (CLAUDE FINISHED 13:57:18 → vaiko STOP 13:57:42 → verdict=done → rollback restored 2 → darbas dingo) ir pasirink kryptį 3 (bounded stop-bridge laukimas PRIEŠ verify + necommit'into darbo išsaugojimas prieš rollback'ą), pagrįsdamas, kodėl 1 ar 2 po vieną palieka spragą.
- Užrašyk kontraktą: kaip `restoreTaskScope` išsaugo necommit'intą turinį (snapshot ref / stash su task žyma), kokiu lauku tai grąžina, kur ta vieta įrašoma, kad pasiektų `rollback-stable` išvestį ir `verify-task` human-review priežastį.
- Nurodyk, kad esamas `src/application/task-execution/stop-bridge-wait.ts` naudojamas nepakeistas (`stop-bridge` kontraktas neliečiamas), ir įvardyk, kurie failai keisis tolesniuose darbuose.

## Patikra
- `git diff --check`
- `pnpm typecheck`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok nedelsiant, jei sprendimas reikalautų keisti `src/infrastructure/state/stop-bridge` kontraktą — tai atskiro patvirtinimo riba.

## Neįtraukta
- Bet koks `src/**` keitimas (eina atskirais darbais: rollback-scope išsaugojimas, rollback-stable išvestis, verify-task priežastis, coordinator laukimas).
- R1 (uždaryta 020-a-02), `hook-post-bash` praplėtimas, queue loop vykdymas.
