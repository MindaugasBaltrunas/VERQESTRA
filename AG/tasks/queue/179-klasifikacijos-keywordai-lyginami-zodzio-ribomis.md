# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/policies/task-classification.ts` `classifyTask` keyword'ų paieška (57 eil.) nebenaudoja
gryno `textHaystack.includes(...)`, o tikrina žodžio ribas (tekstas su `migration-coverage.json` neduoda
kategorijos `data`, tekstas su `release-readiness` neduoda `release`) ir
`src/tests/domain-policies.test.ts` tai tvirtina —
ALREADY_IMPLEMENTED: cituok ribų funkciją ir testo pavadinimą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, D2): `task-classification.ts:57`
`rule.keywords.find((value) => textHaystack.includes(value.toLowerCase()))` — keyword'ai lyginami be
žodžio ribų, nors antraštė (1-5 eil.) teigia, kad 2026-07-29 audito pamoka „bare keyword'ai kėlė 32 %
dispatch'ų į opus" užkoduota; ribas turi TIK `pathFragmentMatches` (86-106 eil.). Numatytieji
keyword'ai (`task-classification-defaults.ts`, tas pats sąrašas `templates/vq/config/task-classification-policy.json`):
`add`, `ui`, `api`, `test`, `docs`, `migration`, `release`, `policy`, `secret`, `approval`.
Pasekmės VERQESTRA task'ams: paminėtas `migration-coverage.json` (CLAUDE.md to reikalauja) → `data`
→ opus/high; `release-readiness` → `release` → opus; „build"/„guide" → `ui` → feature.
Sutampa su 2026-09-03 modelių audito radiniu (opus 22 % dispatch'ų = 42 % išlaidų).
Sprendimo kryptis: keyword'as atitinka tik kai iš abiejų pusių ribojasi ne-žodžio simboliu arba
teksto kraštu — ta pati taisyklė, kurią jau taiko `pathFragmentMatches` (raidė/skaitmuo = žodžio
simbolis; keyword'ai su savo skirtuku, pvz. `fix typo`, ribų iš tarpo pusės nereikalauja).
Klasifikacija veikia pack'o biudžetą (`assemble.ts:92-98` → `max_context_chars`), todėl keliamas
`CONTEXT_CACHE_VERSION`.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/policies/task-classification.ts` (`classifyTask` 57 eil.; ribų helper'is greta `pathFragmentMatches`)
- `src/tests/domain-policies.test.ts`
- `src/application/context-pack/context-cache-model.ts` (`CONTEXT_CACHE_VERSION` 129 eil.: 13 → 14)
- `src/tests/context-pack-code-index-identity.test.ts` (pin'as 54 eil.)
- `src/tests/context-pack-guards.test.ts` (pin'as)

Draudžiama:
- `src/domain/policies/task-classification-defaults.ts` (keyword'ų sąrašas nekinta — keičiasi tik lyginimo taisyklė)
- `templates/vq/config/task-classification-policy.json`
- `src/application/context-pack/assemble/assemble.ts` (politikos loader'is — task 185)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `task-classification.ts`: išskirti `textKeywordMatches(haystack, keyword)` (arba pernaudoti
  `pathFragmentMatches` logiką per bendrą vidinę funkciją) ir naudoti 57 eil. vietoje `includes`.
  Antraštės 1-5 eil. teiginį suderinti su realybe.
- Pakelti `CONTEXT_CACHE_VERSION` (13 → 14) `context-cache-model.ts`, nes klasifikacija keičia
  `optimizeTokenBudget` rezultatą ir pack'o turinį; atnaujinti pin'us
  `context-pack-code-index-identity.test.ts:54` ir `context-pack-guards.test.ts`.
- Korpuso patikra (2026-09-04 task 157 pamoka): Grep'u per `AG/tasks/queue/*.md` ir `AG/tasks/done/*.md`
  surinkti task'us, kurių kategorijų rinkinys pasikeistų (pvz. tekstuose su `migration-coverage`,
  `release-readiness`, `build`, `guide`, `add-on`) ir pateikti ataskaitoje „buvo → tapo" sąrašą.
  Korpuso task'ų redaguoti NEREIKIA — klasifikacija nėra raudonas vartas; ataskaita yra įrodymas.
- Testai `domain-policies.test.ts`: `migration-coverage.json` → be `data`; `release-readiness` → be
  `release`; `Add users table` → `feature` (žodis `add` ribotas tarpais — kaip iki šiol);
  `database migration` → `data`; `ui` viduryje `build` NEatitinka, `UI` kaip atskiras žodis atitinka.
  `src/tests/quality-gates-preflight.test.ts:218` ir `src/tests/context-pack-assemble.test.ts:319,329`
  fixture'ai (`implement feature x`, `Fix typo in README`, `Add users table`) privalo likti žali be
  jų redagavimo — jei raudonuoja, klaida yra ribų taisyklėje, ne fixture'e.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei ribų taisyklė paverčia `routine` kurį nors
korpuso task'ą, kuris šiandien yra `policy-sensitive` dėl `secret`/`approval` keyword'o
(klasifikacija žemyn saugumo kategorijai yra operatoriaus sprendimas).

## Neįtraukta
- `assemble.ts` konfigo politikos skaitymas ir human-review/split balsai — task 185.
- Keyword'ų sąrašo turinys (`task-classification-defaults.ts`, šablonas) — nekeičiamas.
- `route-model.ts` `HIGH_COMPLEXITY_PATTERN` (kita klasifikacija, kita pakopa) — task 186/195.
