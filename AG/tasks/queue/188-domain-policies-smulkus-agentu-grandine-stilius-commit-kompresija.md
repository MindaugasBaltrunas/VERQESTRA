# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 179-klasifikacijos-keywordai-lyginami-zodzio-ribomis

## Žingsnis 0 — ar jau įgyvendinta?
Tikrinti po punktą: (1) `src/domain/policies/agent-selection.ts:64` `LEADING_LABEL` nebėra godus
iki paskutinio dvitaškio (`coder: implementuoja` → rolė `coder` išlieka); (2) `agent-selection.ts:193-201`
adapteris validuojamas prieš `effectiveAgentRole`, ne `known[0]`; (3) `src/domain/policies/architecture-style.ts:140-147`
„confirmed" pažeidimas reikalauja briaunos, ne vien scope kelio viename gale; (4) `src/domain/policies/commit-message.ts:6`
turi `docs`; (5) `src/domain/policies/compression/canary.ts:37` be `Buffer`; (6) `compression/arrest.ts:187-190`
`=== null` šaka gyva arba pašalinta. Visi — ALREADY_IMPLEMENTED su citatomis; kitaip daromi likę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Domain; `audit-domain.md`
#8, #12 (commit dalis), #14, #15, #19 (canary dalis), #35).
- #14 `agent-selection.ts:64` `LEADING_LABEL = /^.*:\s*/s` godus iki PASKUTINIO dvitaškio tokene:
  `coder: implementuoja` → `implementuoja` (rolė dingsta); `readme-guard: skaito README → coder` →
  pirmas tokenas `skaito README` → etalonas-rules `agentai-readme-guard-not-first` false positive.
  Testai pina tik label'į PRIEŠ visą grandinę. Kryptis: label'is — tik iki PIRMO dvitaškio ir tik
  jei prieš jį nėra žinomos rolės vardo.
- #15 `agent-selection.ts:193-201` adapteris validuojamas prieš `known[0]` (dažnai `readme-guard`,
  `allowed_adapters: ["claude"]`), o vykdymo rolė = `effectiveAgentRole` (praleidžia readme-guard):
  `adapter: codex` grandinei `readme-guard → coder` atmetamas, nors coder codex leidžia.
- #8 `architecture-style.ts:140-147` → `node-verification-rules.ts:160`: „confirmed" pažeidimas, kai
  scope kelias guli BET KURIAME briaunos gale — mazgas, implementuojantis `src/infrastructure/x.ts`,
  gauna `Forbidden dependency: "domain -> infrastructure"` blokerį be briaunos įrodymo.
  `migration-coverage.json:587-591` tai vadina griežtinančiu nukrypimu, bet „liečia galą" ≠
  „realizuoja priklausomybę". Kryptis: confirmed tik kai scope liečia ŠALTINIO sluoksnį ir yra
  importo įrodymas; kitaip `possible` (preflight jau moka `possible` kelią, `preflight-rules.ts:440`).
- #12 `commit-message.ts:6` meta sąraše `doc`, repo `docs/` → commit'as tik su docs = `feat(docs)`,
  ne `chore`.
- #19 `compression/canary.ts:37` `Buffer` (Node globalas) domain sluoksnyje — vartas gaudo tik
  `node:` importus; `parseInt(hex.slice(0, 8), 16)` būtų grynas.
- #35 `compression/arrest.ts:187-190` `record["counters"] ?? {}` paverčia `=== null` patikrą negyva.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/policies/agent-selection.ts` (64 `LEADING_LABEL`; 193-201 adapterio validacija)
- `src/domain/policies/architecture-style.ts` (140-147 confirmed/possible)
- `src/domain/policies/commit-message.ts` (6 eil. `docs`)
- `src/domain/policies/compression/canary.ts` (37 eil. be `Buffer`)
- `src/domain/policies/compression/arrest.ts` (187-190 eil.)
- `src/tests/domain-policies.test.ts`
- `src/tests/characterization-compression-policy.test.ts`

Draudžiama:
- `src/domain/policies/task-classification.ts` (task 179)
- `src/domain/architecture/node-verification-rules.ts` (vartotojas 160 eil. — task 193; kontraktas `confirmed|possible` nekinta)
- `src/domain/git/changes.ts` (`Buffer` antra vieta — task 194)
- `src/domain/tasks/etalonas-rules.ts` (task 181)
- `migration-coverage.json` (anotacija apie #8 nukrypimą — įrašyti į ataskaitą, ne keisti be pavedimo)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `agent-selection.ts` `parseAgentChain`: label'is nuimamas tik iki PIRMO `:`, ir tik kai kairioji
  dalis NĖRA žinomas rolės vardas (`coder:` lieka rolė); testai — `coder: implementuoja` → `coder`,
  `Privaloma grandinė: readme-guard -> coder` → `readme-guard, coder`, `readme-guard: skaito README ->
  coder` → pirmas `readme-guard`.
- `agent-selection.ts` 193-201: adapteris tikrinamas prieš `effectiveAgentRole(selection, policy)`;
  testas — `readme-guard -> coder` + `adapter: codex`, kai coder leidžia codex → valid.
- `architecture-style.ts` `detectForbiddenDependencyViolations`: `confirmed` tik su importo įrodymu
  iš scope failo į draudžiamą sluoksnį; vien kelias sluoksnyje → `possible`. Testas — mazgas
  `src/infrastructure/x.ts` be importo → `possible`, su `import … from "../infrastructure/…"` iš
  domain failo → `confirmed`.
- `commit-message.ts`: `docs` (palikti `doc` suderinamumui); testas — `docs/x.md` vienas → `chore`/`docs`
  pagal esamą taisyklę, ne `feat(docs)`.
- `canary.ts`: `Buffer` pakeisti grynu `parseInt`; `characterization-compression-policy.test.ts`
  kohortų priskyrimas lieka identiškas (charakterizacija — pinantis testas).
- `arrest.ts`: pašalinti negyvą `=== null` šaką arba tikrinti PRIEŠ `?? {}`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `canary.ts` pakeitimas keičia bent vieno
charakterizacijos atvejo kohortą — kohorta yra task'o savybė (task 0031), jos perskirstymas yra
operatoriaus sprendimas.

## Neįtraukta
- `bash-command-policy.ts:366`, `migration-guard.ts`, `file-classification.ts:40`,
  `check-command-allowlist.ts:215-223`, `scope-guard-rules.ts` (D3) — hooks autorius.
- `dead-export-gate.test.ts` KNOWN/FORWARD sąrašo valymas (#36: `pruneScopeLocks`,
  `EMPTY_SCOPE_LOCK_REGISTRY`, `compareRoutingTier`, `normalizeEnforcementLevel`) — testų/vartų
  autorius (T1).
- `node-verification-rules.ts` `findForbiddenDistImports` — task 193.
