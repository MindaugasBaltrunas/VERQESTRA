# Tasks

- [ ] Praplėsti `session-stage-planning.ts`: pridėti gryną fallback taisyklės funkciją šalia `resolveLedgerGap`, priimančią `dispatchNonce`, planą, `gitStatusPaths`, `allowedPaths`, ownership/baseline duomenis; grąžinti fallback kandidatus arba tuščią rezultatą pagal 4 sąlygas iš spec.
- [ ] Praplėsti `planSessionStaging` įvesties/išvesties tipus, kad kviestojas gautų informaciją, kurie keliai pateko per fallback'ą (atskirai nuo ledger'io ir nuo `resolveLedgerGap` kelių).
- [ ] `on-stop-context.ts:resolveStagePlan` — pridėti `vq/state/current-task-file` skaitymą (per esamą `task-state-store.ts`) ir `parse-task.ts:parseTask` naudojimą allowed paths gavimui; perduoti juos į `planSessionStaging`.
- [ ] `on-stop.ts:logStagingEvidence` — pridėti `STAGING LEDGER FALLBACK: task=<id> +N files: ...` eilutę šalia esamų `SESSION LEDGER MISS` / `STAGING LEDGER GAP` eilučių, suveikiančią tik kai fallback pritaikytas.
- [ ] `src/tests/application-session-stage-planning.test.ts` — pridėti 018 regresijos teigiamą scenarijų ir siaurinimo (vienas kelias už ribų) neigiamą scenarijų; patikrinti nepriklausomumą nuo `resolveLedgerGap`.
- [ ] `src/tests/interfaces-hooks-on-stop.test.ts` — patikrinti garsios žymos buvimą suveikimo atveju ir nebuvimą, kai fallback'as neįsijungia.
- [ ] Paleisti `pnpm typecheck && pnpm test` (lint → build → testai) ir patvirtinti, kad architektūros vartai (`src/tests/architecture-gates.test.ts`) praeina.
- [ ] Patikrinti, kad nė vienas pakeistas failas neviršija 500 eilučių ir importų grafas lieka aciklinis.

## AG Queue Tasks

- **020-a-02** (jau egzistuojanti eilėje) — praplėsti jos „Failai / Leidžiama" sąrašą trimis šiuo metu jame nesančiais įrašais: `src/application/task-execution/session-stage-planning.ts`, `src/interfaces/hooks/on-stop-context.ts`, `src/tests/application-session-stage-planning.test.ts`. Pastaba vykdytojui: `session-write-ledger.ts` ir `stop-guards.ts`, šiuo metu esantys sąraše, pagal šią diagnozę **neturėtų būti liečiami** — pasiūlyti jų pašalinimą iš sąrašo, ne tyliai praleisti.
- **020-b-03** (atskira eilė, ne šio change dalis) — 015 matomumo spraga `diagnose-evidence.ts:86-90`; jos „Leidžiama" sąrašas (`src/domain/git/changes.ts` + testas) taip pat nesutampa su realiu taikiniu — reikės atskiro patikslinimo prieš vykdymą.
- **R2 task (dar nesuformuluotas)** — commit'as nespėja iki dispatch pabaigos prieš task-scoped rollback'ą (įrodymas A, 018); reikalauja atskiros diagnozės apie Stop hook'o vykdymo laiką/eiliškumą, nesprendžiama šiuo change'u.
