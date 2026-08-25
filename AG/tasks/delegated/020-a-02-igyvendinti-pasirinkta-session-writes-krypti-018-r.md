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
Įgyvendinti `AG/tasks/active/020-diagnosis.md` pasirinktą kryptį, kad subagente atliktas darbas nebebūtų laikomas svetimu, ir padengti tai regresiniu testu.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/hooks/post-write.ts`
- `src/interfaces/hooks/session-write-ledger.ts`
- `src/interfaces/hooks/on-stop.ts`
- `src/interfaces/hooks/stop-guards.ts`
- `src/tests/interfaces-hooks-post-write.test.ts`
- `src/tests/interfaces-hooks-on-stop.test.ts`
- `src/tests/interfaces-hooks-session-write-ledger.test.ts`

Draudžiama:
- `src/composition/**`
- `src/domain/**`
- `templates/.claude/settings.json`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Įgyvendink diagnozėje pasirinktą vieną kryptį; jei tai Stop hook fallback, jis privalo būti siaurinantis: veikia tik kai VISI `git status` pakeitimai telpa į aktyvaus task'o allowed paths, ir palieka garsią žymą žurnale.
- Pridėk regresinį testą, atkuriantį 018 scenarijų: pakeitimai yra, ledger'is tuščias, allowed paths dengia — tikrinama pasirinkta elgsena.
- Neišplėsk pakeitimo į composition ar domain sluoksnius; failų ribos ≤500 eilučių, jokio naujo `any`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir 018 regresinis testas žalias; commit'inti iš karto. Sustoti nedelsiant, jei prireiktų keisti `templates/.claude/settings.json` arba silpninti esamą Stop hook guard'ą.

## Neįtraukta
- `session-writes.json missing` žymos darbas rollback/attribution kelyje (atskiras task'as).
- 018 turinio darbai (benchmark integrity).
