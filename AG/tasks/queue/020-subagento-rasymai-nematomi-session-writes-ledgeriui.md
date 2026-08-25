# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
Uždaryti sisteminę spragą: vykdytojo darbas, atliktas per Agent/subagentus, nepatenka į
session-writes ledger'į, todėl Stop hook'as jį laiko SVETIMU ir commit'o nedaro, o
orkestratorius teisingą necommit'intą darbą atsuka ir parkuoja į human-review.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/hooks/**`
- `src/composition/hooks/**`
- `src/domain/git/changes.ts`
- `src/tests/**`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- ĮRODYMAS (2026-08-25, task 018 pirmas bandymas): dispatch tool usage
  `main=Agent,ScheduleWakeup agent=Bash,Edit` — visi rašymai subagente; diagnosis
  `verdict=done reason=checks passed and changed files are inside allowed paths`; stop hook'as
  commit'o NEpadarė; verify `ROLLBACK TASK-SCOPED: restored 2 task path(s)` + `Claude did not
  create a new commit` → teisingas darbas sunaikintas. Gretimas simptomas: 015 verify metu
  `WARNING: session-writes.json missing — skipping out-of-scope attribution`.
- IŠTIRTI: ar PostToolUse hook-post-write apskritai gauna subagento Write/Edit įvykius šioje
  Claude Code konfigūracijoje; jei gauna — kodėl įrašai nepasiekė ledger'io.
- SPRENDIMO KRYPTYS (architect renkasi vieną, pagrindžia):
  1. ledger'io pildymą padaryti nepriklausomą nuo įrankio kilmės (subagento rašymai fiksuojami);
  2. Stop hook fallback: kai ledger'is tuščias, o `git status` pakeitimai VISI telpa į aktyvaus
     task'o allowed paths — stage'inti juos su garsia žyma žurnale (siaurinanti, ne fail-open);
  3. dispatch sandbox'e uždrausti Agent įrankį rašymo fazei (offered tools sąrašo pakeitimas).
- Pasirinktą kryptį padengti regresiniu testu, kuris atkuria 018 scenarijų: pakeitimai yra,
  ledger'is tuščias, allowed paths dengia — ir tikrina pasirinktą elgesį.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir 018 scenarijaus regresinis testas žalias. Commit'inti iš karto.
Sustoti nedelsiant, jei sprendimas reikalautų keisti Claude Code settings kontraktą
(`templates/.claude/settings.json`) — tai operatoriaus patvirtinimo riba.

## Neįtraukta
- 018 turinio darbai (benchmark integrity — atskiras task'as).
- Dispatch tool sąrašo politika kitiems tikslams.
- LLM kvietimai, queue loop vykdymas.
