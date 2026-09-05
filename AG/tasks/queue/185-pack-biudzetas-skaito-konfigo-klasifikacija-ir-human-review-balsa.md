# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 179-klasifikacijos-keywordai-lyginami-zodzio-ribomis

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/context-pack/assemble/assemble.ts` `optimizeTokenBudget` kvietime (92-98 eil.)
`classification` gaunama per `loadTaskClassificationPolicy(deps.fs, runtimeRoot)` (ne
`defaultTaskClassificationPolicy`) ir paduodamas `humanReview` balsas iš `analyzeHumanReviewGates`,
o `CONTEXT_CACHE_VERSION` pakeltas po 179 — ALREADY_IMPLEMENTED: cituok kvietimą, importą ir
versijos reikšmę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, A3; application CP-1).
`assemble.ts:92-98`: `classifyTask(taskText, parsedTask.allowedPaths, defaultTaskClassificationPolicy)`
su komentaru „Klasifikacijos konfigo loader'is — VQ-305; iki jo…" — pasenęs: `loadTaskClassificationPolicy`
(`src/application/policy-governance/task-classification-policy.ts:20`) egzistuoja ir naudojamas
preflight'e (`interfaces/cli/dispatch/claude-preflight/index.ts:203`) bei
`composition/quality/adapters.ts:150`. Preflight (`preflight.ts:97-106`) tą pačią užduotį vertina su
konfigo politika + `humanReview` + `splitRequired` → kitas tier → kitas `max_context_chars`
(6000/12000/base). Pack'as gali būti suspaustas, kai preflight paskelbė large, arba atvirkščiai.
Kešo raktas (`infrastructure/persistence/context-cache-store.ts:51-57` `CONTEXT_CACHE_POLICY_FILES`)
neša `task-classification-policy.json`, kurio assemble NESKAITO — pažeidžia to paties failo
taisyklę „konfigo failas, kurio niekas neskaito, į raktą nededamas". Šablono
`task-classification-policy.json` `_comment` žada „konfigas turi pirmumą prieš kodą" — čia jo nėra.
Kryptis: assemble skaito konfigą per esamą `withPolicyConfigErrors(configFile("task-classification-policy.json"), …)`
allowlist'ą (tas pats „environment scope" kontraktas kaip kitiems loader'iams 87-100 eil.), balsą
`humanReview` skaičiuoja per `analyzeHumanReviewGates(taskText, allowedPaths)` (domain, grynas).
`splitRequired` balsas reikalauja preflight'o split plano, kurio assemble neturi — paliekamas
Neįtraukta su doc'u. Pack'o turinys keičiasi → keliamas `CONTEXT_CACHE_VERSION`.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/assemble.ts` (92-98 eil.; importai `loadTaskClassificationPolicy`, `analyzeHumanReviewGates`)
- `src/tests/context-pack-assemble.test.ts`
- `src/application/context-pack/context-cache-model.ts` (`CONTEXT_CACHE_VERSION` +1 po 179)
- `src/tests/context-pack-code-index-identity.test.ts` (pin'as)
- `src/tests/context-pack-guards.test.ts` (pin'as)

Draudžiama:
- `src/application/policy-governance/task-classification-policy.ts` (loader'is importuojamas, nekinta)
- `src/infrastructure/persistence/context-cache-store.ts` (raktas jau teisingas)
- `src/interfaces/**`
- `src/composition/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `assemble.ts`: `const classificationPolicy = await withPolicyConfigErrors(configFile("task-classification-policy.json"),
  () => loadTaskClassificationPolicy(deps.fs, runtimeRoot))`; `classifyTask(..., classificationPolicy)`;
  `const humanReview = analyzeHumanReviewGates(taskText, parsedTask.allowedPaths)` ir
  `...(humanReview.requires_human_review ? { humanReview } : {})` į `optimizeTokenBudget` — identiškai
  `preflight.ts:100-106`. Pasenusį VQ-305 komentarą pakeisti nuoroda į šį task'ą.
- Pakelti `CONTEXT_CACHE_VERSION` `context-cache-model.ts` (po 179 reikšmė 14 → 15) ir atnaujinti
  pin'us `context-pack-code-index-identity.test.ts` bei `context-pack-guards.test.ts`.
- Testai `context-pack-assemble.test.ts`: fake fs su `vq/config/task-classification-policy.json`,
  kuriame `feature.keywords` papildytas unikaliu žodžiu → pack'o `budget.max_context_chars` atitinka
  konfigo tier'ą, o su default'ais — ne; task'as su security keyword'u (human-review balsas) gauna
  didesnį biudžetą nei be jo; sugadintas konfigas → `withPolicyConfigErrors` environment klaida
  (kaip `context-budget.json` atveju).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `characterization-context-pack-assembly.test.ts`
ar `infrastructure-context-pack-real.test.ts` (ne šio scope) raudonuoja dėl pasikeitusio biudžeto
realiam korpusui — tada reikia operatoriaus sprendimo dėl charakterizacijos atnaujinimo.

## Neįtraukta
- `splitRequired` balsas assemble pusėje — preflight split plano assemble neturi; įrašyti doc'e.
- `assemble.ts:319` `max_llm_calls: 3` hardcoded (CP-3), overflow kopėčios be `symbol_slices` (CP-4),
  trijų `max_context_chars` dydžių suderinimas (CP-2) — task 190.
- Kešo rakto politikos failų sąrašas (`context-cache-store.ts`) — jau teisingas, nekinta.
