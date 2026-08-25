# Proposal

## Why

`vq/state/session-writes.json` yra įrankio kilmės ledger'is: jį pildo tik `PostToolUse` `Write|Edit` kanalas (`post-write.ts:hookPostWrite`). `Bash`/`PowerShell` kanalas (`post-hooks.ts:hookPostBash`) į ledger'į nerašo nieko. Stop hook'as stage'ina TIK ledger'io aibę (`git add --all` niekada nevykdomas), tad bet koks produkto pakeitimas, padarytas ne `Write|Edit` įrankiu, į commit'ą nepatenka.

Du diagnozuoti gedimo režimai: **R1 — ledger'is aklas** (kelio ledger'yje niekada nebuvo — `comparison.ts` atvejis) ir **R2 — commit'as nespėja** prieš task-scoped rollback'ą (018 atvejis; ledger'yje kelias BUVO). Šis change adresuoja tik **R1**. Du esami saugikliai (clean-baseline rescue, `resolveLedgerGap`) veikia tik švarios ar be baseline'o sesijos atveju ir todėl neįsijungia būtent ilgesniuose, daugiaetapiuose bandymuose su galiojančiu baseline'u ir jau purvinu medžiu — o ten prarandama daugiausia darbo.

## Scope

- `src/application/task-execution/session-stage-planning.ts` — nauja gryna taisyklė šalia `resolveLedgerGap`: ar visi ne-runtime purvini `git status` keliai telpa į aktyvaus task'o leidžiamų kelių aibę; jei taip — jie tampa fallback stage'inimo kandidatais.
- `src/interfaces/hooks/on-stop-context.ts` — IO praplėtimas: aktyvaus task'o leidžiamų kelių (`allowedPaths`) įvedimas į `planSessionStaging` per esamą `vq/state/current-task-file` skaitymą ir esamą `parse-task.ts` parserį (tik importuojama, nekeičiama).
- `src/interfaces/hooks/on-stop.ts` — garsi, grep'inama žurnalo žyma `logStagingEvidence` funkcijoje, kai fallback'as suveikia.
- Regresiniai testai: `src/tests/application-session-stage-planning.test.ts` (fallback taisyklės teigiamas ir neigiamas atvejis), `src/tests/interfaces-hooks-on-stop.test.ts` (žurnalo žymos įrodymas).

## Out Of Scope

- **R2** (commit'as nespėja prieš rollback'ą) — atskiras, dar nesuformuluotas task'as; šis change jo neuždaro ir juo nepakeičiamas.
- 015 matomumo spraga (`diagnose-evidence.ts:86-90` tyliai praleidžia out-of-scope attribution, kai `!ledger.present`) — atskiras 020-b-03 darbas.
- `hook-post-bash` praplėtimas iki tikro darbo ledger'io (naujas `PostToolUse` matcher'is `templates/.claude/settings.json`) — reikalauja operatoriaus patvirtinimo, atviras klausimas po šio change.
- `src/interfaces/hooks/session-write-ledger.ts` — rašymo mechanika sveika, nekeičiama.
- `src/interfaces/hooks/stop-guards.ts` — blokuojantys pre-commit guard'ai, ledger'io neliečia, ne šio defekto dalis.
- `templates/.claude/settings.json` — matcher'iai nekeičiami.

## Architecture Boundaries

- **Moduliai:** `application/task-execution` (gryna taisyklė) + `interfaces/hooks` (IO wiring ir logging). Sluoksnių riba išlaikoma: `application` nepriklauso nuo `interfaces`; naują IO atlieka `on-stop-context.ts`, o `session-stage-planning.ts` gauna `allowedPaths` jau kaip įvestį (be failų sistemos skaitymo).
- **Reads DB:** nėra (projektas neturi DB šiai sričiai). Skaitomi state failai: `vq/state/current-task-file` (per esamą `task-state-store.ts`), `vq/state/session-writes.json` (per esamą ledger skaitymą), `git status` išvestis.
- **Writes DB:** nėra. Vienintelis rašymas — `git add` stage'inimas jau egzistuojančiu mechanizmu ir žurnalo eilutė per `on-stop.ts`.
- **Job types:** nėra (hook'ų grandinė, ne job queue).
