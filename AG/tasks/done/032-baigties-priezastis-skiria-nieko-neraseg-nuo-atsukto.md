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
openspec/changes/verqestra-backlog-v1
`src/domain/diagnosis/dispositions.ts:224`

## Tikslas
Domeno taisyklė turi mokėti atskirti dvi baigtis: „vykdytojas nieko nerašė" ir „darbas atsuktas". Šiandien abi virsta ta pačia priežastimi `clean tree without work evidence (deliverable missing — possibly rolled back)`, ir operatorius siunčiamas ieškoti darbo, kurio nebuvo.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/diagnosis/dispositions.ts`
- `src/tests/characterization-diagnosis.test.ts`
- `src/tests/domain-vq204.test.ts`
- `src/tests/fixtures/characterization/diagnosis-dispositions.json`

Draudžiama:
- `src/application/**`
- `src/composition/**`
- `src/infrastructure/**`
- `node_modules/**`
- `dist/**`

## Veiksmas
- `NoCommitDoneInputs` gauna NAUJĄ įėjimą apie vykdytojo rašymo aktyvumą su TRIMIS būsenomis (pvz. `"wrote" | "no-writes" | "unknown"`), neprivalomą, default `"unknown"`, kad esami kvietėjai liktų kompiliuojami. `resolveNoCommitDisposition` grąžinamos reikšmės NEKINTA nė vienoje šakoje.
- Pridėk gryną eksportą, kuris grąžina human-review priežasties eilutę iš tų pačių įėjimų: kai aktyvumas `"no-writes"` — priežastis privalo pasakyti `executor made no write-tool calls`; visais kitais atvejais (`"wrote"` ir `"unknown"`) grąžinama esama `clean tree without work evidence (deliverable missing — possibly rolled back)`. `"unknown"` niekada negamina naujos priežasties — tyli ar neatpažinta sesija nėra įrodymas.
- Testai: `"no-writes"` → nauja priežastis; `"wrote"` ir `"unknown"` → sena priežastis; visais trim atvejais dispozicija ta pati `human-review`. Atnaujink `src/tests/fixtures/characterization/diagnosis-dispositions.json` ir `src/tests/characterization-diagnosis.test.ts`, jei keičiasi įėjimų forma.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok nedelsiant, jei sprendimas imtų reikšti, kad task'as be rašymų uždaromas kaip `done` — tai 2026-08-14 false-done regresija ir šio task'o apimtis to neįtraukia. Sustok ir jei domenui prireiktų `node:` importo ar log'o skaitymo — signalas ateina parametru.

## Neįtraukta
- Priežasties prijungimas prie `verify-task.ts` ir port'o (atskiras vaiko task'as).
- Infrastruktūros rašymo-įrankio helper'is (atskiras vaiko task'as).
- Skaidymo taisymas (task 033), `ALREADY_IMPLEMENTED` semantika, automatinis uždarymas.
