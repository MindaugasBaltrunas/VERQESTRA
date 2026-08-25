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
Nustatyti, kodėl per Agent/subagentus atlikti rašymai nepatenka į session-writes ledger'į, ir užrašyti vieną pagrįstą sprendimo kryptį. Produkto kodo šiame darbe NEKEISTI.

## Agentai
Privaloma grandinė: readme-guard -> architect -> reviewer

## Failai
Leidžiama:
- `AG/tasks/active/020-diagnosis.md`

Draudžiama:
- `src/**`
- `templates/.claude/settings.json`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Perskaityk grandinę `src/interfaces/hooks/post-write.ts`, `src/interfaces/hooks/session-write-ledger.ts`, `src/interfaces/hooks/on-stop.ts`, `src/interfaces/hooks/stop-guards.ts` ir nustatyk, kur subagento Write/Edit įvykis prarandamas iki ledger'io.
- Užfiksuok 018 įrodymą (tool usage `main=Agent agent=Bash,Edit`, `verdict=done`, stop hook be commit'o, `ROLLBACK TASK-SCOPED: restored 2 task path(s)`) ir 015 simptomą (`session-writes.json missing`) kaip to paties defekto atvejus.
- Į `AG/tasks/active/020-diagnosis.md` surašyk: šaknies priežastį, pasirinktą vieną kryptį iš trijų (ledger nepriklausomas nuo įrankio kilmės / Stop hook siaurinantis fallback / Agent draudimas dispatch sandbox'e), atmestų priežastis ir konkrečius failus bei testą, kuriuos lies įgyvendinimas.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Sustoti, kai diagnozės failas parašytas ir patikros žalios; commit'inti iš karto. Sustoti nedelsiant, jei pasirinkta kryptis reikalautų keisti `templates/.claude/settings.json` — tai operatoriaus patvirtinimo riba.

## Neįtraukta
- Bet koks produkto kodo ar testų keitimas (eina atskiru task'u).
- 018 turinio darbai (benchmark integrity).
- Dispatch tool sąrašo politika kitiems tikslams.
