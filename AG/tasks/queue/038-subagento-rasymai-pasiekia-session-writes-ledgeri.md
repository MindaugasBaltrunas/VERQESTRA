# Task

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
