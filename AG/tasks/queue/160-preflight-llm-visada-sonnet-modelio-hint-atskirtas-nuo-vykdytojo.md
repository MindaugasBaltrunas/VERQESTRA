# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/cli/dispatch/claude-preflight/index.ts` LLM kvietimo modelį
(`ports.resolveModel(...)`, ~249 eil.) ima iš konstantos/konfigo, nepriklausomo nuo
`optimizedBudget.model_policy_hint`, o `logTokenUsage("preflight", …)` rašo TĄ modelį, kuris
realiai kvietė — ALREADY_IMPLEMENTED: cituok konstantą, `resolveModel` kvietimą ir
`token-usage.jsonl` eilutės `model` lauko šaltinį.

## Tikslas
Modelių auditas `docs/audits/model-efficiency-audit-2026-09-03.md` R4: 125 LLM preflight'ų —
**85 opus'e (≈ 47 $), 40 sonnet'e (≈ 12 $)**; opus preflight'as kainuoja 0,5–0,95 $, sonnet ≤ 0,44 $.
Priežastis — `claude-preflight/index.ts:246-249`: preflight'o LLM modelis = `optimizedBudget.
model_policy_hint`, t. y. task'o DYDŽIO/rizikos pakopa. Struktūriškai didelis task'as gauna opus
REFORMULAVIMĄ, o reformulavimas, sekcijų normalizavimas ir skėlimo planas nėra opus lygio darbas;
90 % opus preflight'ų verdiktas — „vykdyk sonnet'u". Tas pats kintamasis (`preflightTier`) tarnauja
trims dalykams: LLM modeliui (249), dispatch'o `selected_model` užuominai (284) ir log'ui
(258, 308) — dėl to 09-03 optimizavimo auditas `model=opus` log'e perskaitė kaip vykdymo modelį.
Sprendimas: LLM kvietimo modelis atskiriamas nuo užuominos ir fiksuojamas `sonnet`; užuomina
vykdytojui lieka iš optimizatoriaus.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/index.ts` (497 eil. — pakeitimas be eilučių prieaugio arba su išėmimu)
- `src/interfaces/cli/dispatch/claude-preflight/preflight-llm.ts` (`tier` lauko doc'as 176-178 eil.)
- `src/tests/interfaces-cli-preflight-model.test.ts` (numatomas naujas — `interfaces-cli-preflight.test.ts` yra 499 eil.)

Draudžiama:
- `src/application/token-governance/token-budget-optimizer.ts` (`model_policy_hint` semantika nekinta)
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-routing-plan.ts` (vykdytojo modelį renka routing'as, ne preflight'as)
- `src/tests/interfaces-cli-preflight.test.ts` (499 eil.; esami testai lieka žali nekeisti)
- `vq/config/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `index.ts`: konstanta `PREFLIGHT_LLM_TIER = "sonnet"` su doc'u (kodėl ne hint'as: 85/125 opus,
  90 % verdiktų sonnet'ui); `const model = await ports.resolveModel(PREFLIGHT_LLM_TIER)`;
  `preflightTier` lieka TIK kaip užuomina `selected_model` (284 eil.) ir deterministinio kelio
  log'ui (308) — semantika vykdytojui nekinta.
- `logTokenUsage("preflight", …)` ir `preflight-llm.ts` `tier` laukas gauna REALŲ kvietusį modelį
  (`PREFLIGHT_LLM_TIER`), ne užuominą — `token-usage.jsonl` `model` laukas nustoja meluoti.
- Log eilutė 258: `model=` tampa `model_hint=`, o gale pridedamas `preflight_llm=sonnet`; jei
  esamas testas pina eilutės formą — forma paliekama ir pridedamas TIK naujas laukas gale.
- Testai (naujas failas): LLM kvietimas visada `resolveModel("sonnet")` nepriklausomai nuo
  `model_policy_hint` (`opus`, `haiku`, aktyvus OpenSpec); `selected_model` užuomina toliau seka
  hint'ą (opus hint → `selected_model: "opus"`); `logTokenUsage` antras argumentas — `"sonnet"`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad `interfaces-cli-preflight.test.ts`
pina `logTokenUsage("preflight", "opus")` ar `model=opus` log'o formą — tada tas testas taisomas
atskiru task'u prieš šį, ne silpninamas čia.

## Neįtraukta
- Preflight LLM modelio konfigūravimas per `token-budget.json` — konstanta pakanka, kol nėra
  duomenų, kad kuriam nors task'ui reikia kito.
- `DEFAULT_MODEL` / `models.env` tier→ID atvaizdavimas — nekinta.
- Turn'ų lubos ir eskaluoto bandymo biudžetas — task 159.
