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
docs/audits/021-rollback-preserve-design-2026-08-25.md

## Tikslas
Perduoti A-02 išsaugoto darbo vietą per `rollback-stable` kelią: portas ir CLI išvestis privalo pasakyti operatoriui, KUR darbas guli, ir įrašyti tai į būseną, kad pasiektų verify.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/bootstrap/rollback-stable.ts`
- `src/tests/interfaces-cli-rollback-stable.test.ts`

Draudžiama:
- `src/infrastructure/**`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Išplėsk `restoreTaskScope` porto tipą išsaugojimo lauku ir įrašyk jį į CLI išvestį bei būsenos įrašą pagal design'e nurodytą kelią.
- Kai išsaugojimo nėra, elgesys nesikeičia — jokio fail-open kelio ir jokio tylaus praleidimo.
- Testu patikrink, kad išsaugota vieta matoma išvestyje, kai portas ją grąžina.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok, jei prireiktų keisti `stop-bridge` kontraktą ar kitą public CLI komandą.

## Neįtraukta
- `verify-task` priežastis ir coordinator laukimas — atskiri darbai.
