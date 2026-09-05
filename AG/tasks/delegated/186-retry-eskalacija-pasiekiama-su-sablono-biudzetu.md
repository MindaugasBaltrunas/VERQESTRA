## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/token-governance-gates.test.ts` turi testą, kuris su šablono reikšmėmis
(`templates/vq/config/tool-budget.json` `max_llm_calls: 3`, `templates/vq/config/model-policy.json`
`defer_steps: 1`, `freeze_escalation_under_budget_pressure: true`) trečiam dispatch'ui po dviejų
nesėkmių gauna `routeModel` sprendimą su `retry-escalation` (ne `budget-freeze`) — ALREADY_IMPLEMENTED:
cituok testą ir `route-model.ts` sąlygą, kuri tai leidžia.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, A4 PLAUSIBLE; application TG-1).
`src/application/token-governance/route-model.ts:255-265` + `tool-budget-rules.ts:106,133-136`:
šablono `max_llm_calls: 3` ir `SOFT_BUDGET_RATIO 0.8` → trečiam dispatch'ui `llmCalls=3`,
`softExceeded(3,3)` = true → `reduce_context=true`; `model-policy.json` `defer_steps: 1` → eskalacija
pirmą kartą būtent trečiam dispatch'ui; `freeze_escalation_under_budget_pressure: true` → `steps=0`
(`budget-freeze`). Struktūriškai retry eskalacija su numatytuoju konfigu NEPASIEKIAMA. Papildomai
`max_total_llm_calls: 12` soft nuo 10 (preflight+dispatch+diagnosis×2 ≈ 8-10). Atitinka 2026-09-03
modelių audito pastabą „eskalacija 1× ir nukirsta" ir „17/21 nesėkmių = turn lubos".
Pirmas žingsnis — MATAVIMO testas, kuris šią struktūrą įrodo su šablono reikšmėmis (testas šablonų
failus tik SKAITO). Jei testas žalias (eskalacija įvyksta) — ALREADY_IMPLEMENTED su testu. Jei
raudonas — sprendimo kryptis kode, ne konfige (šablonai svetimas scope): `budget-freeze` neturi
užšaldyti eskalacijos vien dėl SOFT `reduceContext` signalo, kurį sukelia pats bandomas dispatch'as;
užšaldymas lieka tik kietam išsekimui (`remainingTotalTokens === 0 || remainingTotalLlmCalls === 0`)
arba soft signalui iš TOKENŲ, ne iš kvietimų skaičiaus. Architektas renkasi ir dokumentuoja
`route-model.ts` antraštėje.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/token-governance/route-model.ts` (241-265 eil. eskalacijos žingsniai ir `budget-freeze`)
- `src/application/token-governance/tool-budget-rules.ts` (`softExceeded` 106 eil.; `evaluateLedgerGate` 133-141 eil. soft priežasčių rūšis)
- `src/tests/token-governance-gates.test.ts`

Draudžiama:
- `templates/vq/config/tool-budget.json` (skaitomas teste, nekeičiamas)
- `templates/vq/config/model-policy.json` (skaitomas teste, nekeičiamas)
- `src/application/token-governance/tool-budget-gates.ts` (CP-2 — task 190)
- `src/interfaces/**`
- `src/composition/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Matavimo testas `token-governance-gates.test.ts`: įkelti šablono JSON'us (`node:fs` skaitymas iš
  `templates/vq/config/`), sumodeliuoti ledger'į su 2 nesėkmingais dispatch'ais, pravaryti
  `evaluateLedgerGate` → `reduce_context`, tada `routeModel({ failedAttempts: 2, budget: {...} })`;
  tvirtinti `reason_codes` turi `retry-escalation`. Testo antraštėje — audito nuoroda ir data.
- Jei raudona: `route-model.ts` 256-265 eil. — atskirti soft priežasčių rūšis: `budget.reduceContext`
  dėl LLM kvietimų artėjimo prie `max_llm_calls` NEužšaldo (tai normalus retry kelias), tokenų soft
  ir kieti išsekimai — užšaldo. Tam `RouteModelInput.budget` gali gauti neprivalomą lauką (pvz.
  `reduceContextSource: "llm-calls" | "tokens"`), kurį užpildo `evaluateLedgerGate` per
  `softReasons` klasę — kvietėjai (`coordinator-execution-adapters.ts:160`, `dispatch-routing-plan.ts:59`)
  lauko nepaduoda → senas elgesys; jų keisti negalima (svetimas scope), tad numatytoji reikšmė
  privalo išsaugoti dabartinį verdiktą tiems, kas lauko neduoda. Jei be kvietėjų keitimo tikslo
  pasiekti negalima — žr. Stop.
- `tool-budget-rules.ts`: `softExceeded` doc'e įvardyti, kad prie `max_llm_calls: 3` soft signalas
  suveikia TREČIAM kvietimui; `max_total_llm_calls` soft riba — tik pastaba ataskaitoje, be kodo.
- Regresija: esami `budget-freeze` testai (130 eil. `reduceContext: true` su tokenų spaudimu) lieka žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei eskalacijos atblokavimas be kvietėjų
(`src/composition`, `src/interfaces`) keitimo neįmanomas — tada commit'ink tik matavimo testą su
`test.todo`/skip pagrindimu ataskaitoje ir įvardyk reikalingą kvietėjo pakeitimą.

## Neįtraukta
- Šablono reikšmių (`max_llm_calls`, `defer_steps`) keitimas — templates autorius; šis task'as
  taiso mechanizmą, ne skaičius.
- Turn lubų (`turn-budget.ts`) kalibracija — 2026-09-03 optimizavimo auditas, atskiras sprendimas.
- `route-model.ts:144-145` `SOURCE_CHANGE_PATTERN` dublikatas su preflight (TG-2) — task 195.
