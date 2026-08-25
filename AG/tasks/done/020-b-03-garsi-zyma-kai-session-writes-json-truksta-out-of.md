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
openspec/changes/verqestra-backlog-v1/tasks.md — eilutė „Ištirti orchestrator queue lifecycle lenktynes: Stop hook commit'as nespėja iki dispatch pabaigos"

## Tikslas
Padaryti 015 simptomą matomą: kai ledger'io nėra, out-of-scope attribution neturi tyliai praleisti patikros — praleidimas fiksuojamas aiškiu, testu padengtu signalu.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/git/changes.ts`
- `src/tests/domain-git-changes.test.ts`

Draudžiama:
- `src/interfaces/**`
- `src/composition/**`
- `templates/.claude/settings.json`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Rask vietą, kur trūkstamas ledger'is lemia `skipping out-of-scope attribution`, ir grąžink to praleidimo faktą kaip aiškų rezultato lauką, o ne tik žurnalo eilutę.
- Pridėk testą: ledger'io nėra → rezultatas pažymi praleistą attribution; ledger'is yra → elgsena nesikeičia.
- Jokio `node:` importo `domain` sluoksnyje; failas ≤500 eilučių.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina; commit'inti iš karto. Sustoti nedelsiant, jei signalo prijungimas reikalautų keisti viešą kontraktą už `src/domain/git/changes.ts` ribų.

## Neįtraukta
- Stop hook commit'o elgsenos keitimas (padaryta ankstesniu task'u).
- Dispatch tool sąrašo politika.
