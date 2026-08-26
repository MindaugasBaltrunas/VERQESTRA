## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

> **REZULTATAS 2026-08-26: PRIELAIDA PANEIGTA — task'as uždaromas be įgyvendinimo.**
>
> Šio task'o `## Veiksmas` reikalavo pirma ištirti, ar PostToolUse hook'as subagento įrankių
> kvietimams iškviečiamas. Atsakymas: **iškviečiamas.** Subagento `Write`/`Edit` rašymai pasiekia
> `session-writes` ledger'į, Stop hook'as juos stage'ina, ir jie virsta commit'u.
>
> Kontrapavyzdys (task 030, 2026-08-26): `orchestrator.log:6369` rodo
> `main=Agent,Bash,Grep,ListAgents,Read,ScheduleWakeup agent=Bash,Edit,Glob,Grep,Read` — pagrindinė
> sesija nenaudojo nė vieno rašymo įrankio, rašė tik subagentas — o `hooks.log:1864-1909` turi 7
> `post-write:` eilutes tiems failams; task'as baigė `done` su commit'u.
>
> Tikrosios trijų paskutinių nesėkmių priežastys (R3–R5) ir įrodymai:
> `docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md`.
>
> Žemiau esantis originalus kūnas paliktas nekeistas — kaip įrašas, ne kaip nurodymas.

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/020-session-writes-ledger-diagnosis-2026-08-25.md

## Tikslas
Uždaryti paskutinį nematomą rašymo kanalą: subagento (`Agent` įrankio) atlikti `Write`/`Edit`
kvietimai nepasiekia `session-writes` ledger'io, tad Stop hook'as jų nestage'ina ir darbas
niekada nevirsta commit'u.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/hooks/post-write.ts`
- `src/interfaces/hooks/post-hooks.ts`
- `src/tests/interfaces-hooks-post-write.test.ts`
- `src/tests/interfaces-hooks-on-stop.test.ts`

Draudžiama:
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI (2026-08-26 žurnalas): du dispatch'ai prarado visą darbą tuo pačiu būdu.
  `018-benchmark…` — `main=Agent,ScheduleWakeup agent=Bash,Edit,Glob,Grep,Read` →
  `TASK NOT DONE: Claude did not create a new commit`. `031-grynosios-ui-funkcijos…` —
  `main=Agent,ScheduleWakeup agent=Bash,Glob,Grep,Read,Write` → ta pati baigtis, o 249
  eilutės testų liko tik `refs/verqestra/preserved/3a71161c…`.
- Abiem atvejais pagrindinė sesija NIEKO nerašė — visą darbą atliko subagentas. Ledger'į
  pildo `recordSessionWrite` (`interfaces/hooks/post-write.ts:273`) iš PostToolUse kanalo, o
  Stop hook'as stage'ina tik ledger'io aibę (`git add --all` nevykdomas).
- Spraga patvirtinta paieška: `grep subagent` nerandama nei `post-write.ts`, nei
  `session-write-ledger.ts`, nei `interfaces-hooks-on-stop.test.ts`. Kanalas nepadengtas
  nei kodu, nei testu.
- 2026-08-25 `4a71f25` uždarė GRETIMĄ spragą — Bash kanalą (testas su `bash-written.ts`).
  Subagento kanalas yra tas pats defektas kitu pavidalu, ir jo taisymas priklauso tai pačiai
  vietai. Sprendimas privalo naudoti esamą `appendSessionWrite`, o ne antrą kelią.
- IŠTIRTI PIRMA: ar PostToolUse hook'as subagento įrankių kvietimams apskritai iškviečiamas.
  Jei ne — spraga yra hook'o registracijoje, ne ledger'yje, ir sprendimas kitoks. Rezultatas
  įvardijamas ataskaitoje prieš renkant kelią.
- Testai: subagento įrašytas failas atsiduria stage'inamų aibėje; pagrindinės sesijos
  rašymai elgiasi kaip anksčiau; ledger'io lock semantika (`onLockTimeout: "drop"`) nepakinta.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei sprendimas imtų reikšti `git add --all` — visos
darbo kopijos stage'inimas grąžintų svetimų sesijų failus į task'o commit'ą, o būtent tai
ledger'is ir saugo.

## Neįtraukta
- Bash kanalas (jau uždarytas `4a71f25`).
- Rollback išsaugojimo mechanizmas (veikia — jis ir išgelbėjo abu atvejus).
- `git add --all` kaip alternatyva.
