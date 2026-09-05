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
Tikrinti po punktą: (1) `src/application/policy-governance/json-schema-export.ts` `preflight-limits`
ir `context-budget` schemos sutampa su `preflight-limits-policy.ts` (`z.strictObject`, visi optional,
`turnLimits/fastPath/llmMaxTurns/dispatchMaxTurns/maxSplitDepth`) ir `context-budget.ts` (default'ai,
ne `required`); (2) `src/application/policy-governance/agent-policy.ts:51` `default_role` ne-string
reikšmė meta klaidą, ne tyliai virsta `coder`; (3) `src/application/quality-gates/spec-drift.ts:115-128`
`matchesScope` moka `src/**/*.ts`; (4) `src/application/release-readiness/release-proof.ts:159`
`currentGitSha === undefined` atvejis dokumentuotas kaip fail-open arba tapęs `skipped` su priežastimi.
Visi — ALREADY_IMPLEMENTED su citatomis; kitaip daromi likę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Application; `audit-application.md`
PG-4, PG-5, SD-1, RR-1).
- PG-4 `json-schema-export.ts` vs loader'iai: `preflight-limits` eksportas `required` 4 raktai +
  `additionalProperties: true`, loader'is `z.strictObject` su visais optional; eksportas nemini
  `turnLimits/fastPath/llmMaxTurns/dispatchMaxTurns/maxSplitDepth`. `context-budget` eksportas
  `required: [max_context_chars]`, loader'is — default'ai. Operatorius, validuojantis konfigą pagal
  eksportuotą schemą, gauna priešingą verdiktą nei loader'is. Kryptis: schema generuojama iš to
  paties zod objekto (`z.toJSONSchema` arba rankinis eksportas iš loader'io modulio), ne rašoma
  antrą kartą.
- PG-5 `agent-policy.ts:51` `default_role: z.unknown().transform(v => typeof v === "string" ? v : "coder")`
  — ne-string reikšmė tyliai virsta `coder`, kitur konfigai fail-fast (`withPolicyConfigErrors`).
- SD-1 PLAUSIBLE `spec-drift.ts:115-128` `matchesScope` nemoka glob'ų su `*` viduryje:
  `src/**/*.ts` (turi `/`, nesibaigia `/**`) → prefikso palyginimas → NIEKADA neatitinka → visi
  failai `outside_scope` → `review-required`. `docs/spec-workflow.md` scope vadina glob'ais. Kryptis:
  `matchesAllowedPath` iš `domain/tasks/allowed-paths` (po task 178 `**/` semantika teisinga) vietoje
  savo prefikso logikos. Pradėti nuo testo su `src/**/*.ts`.
- RR-1 `release-proof.ts:159` `currentGitSha === undefined` praleidžia SHA patikrą (fail-open ne-git
  aplinkoje); readiness/benchmark analogai tai dokumentuoja, čia — ne. Kryptis: `skipped` su
  priežastimi `git sha unavailable`, kaip `milestone-check` daro docs atveju.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/policy-governance/json-schema-export.ts`
- `src/tests/policy-governance-json-schema-export.test.ts` (numatomas naujas; eksportas šiandien testuojamas tik `interfaces-cli-spec-tools.test.ts` — jei testas dedamas ten, įrašyti į ataskaitą)
- `src/application/policy-governance/agent-policy.ts` (51 eil.)
- `src/tests/policy-governance-agent-policy.test.ts` (numatomas naujas; `loadAgentPolicy` šiandien tik `context-pack-assemble.test.ts:274`, kuris priklauso task 190)
- `src/application/quality-gates/spec-drift.ts` (115-128 eil. `matchesScope`)
- `src/tests/quality-gates-verify.test.ts`
- `src/application/release-readiness/release-proof.ts` (159 eil.)
- `src/tests/release-readiness.test.ts`

Draudžiama:
- `src/application/policy-governance/preflight-limits-policy.ts` ir `src/application/policy-governance/context-budget.ts` (loader'iai — tiesos šaltinis, nekinta)
- `src/domain/tasks/allowed-paths.ts` (importuojamas, task 178/181)
- `src/interfaces/**`
- `docs/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `json-schema-export.ts`: `preflight-limits` ir `context-budget` schemos iš loader'ių zod objektų;
  testas — eksportuota schema priima tai, ką loader'is priima, ir atmeta tai, ką atmeta (round-trip
  su `parseWithSchema`), įskaitant `turnLimits` raktą ir tuščią `{}` (context-budget default'ai).
- `agent-policy.ts:51`: `default_role: z.string().min(1)` su default `coder` TIK kai laukas
  nepateiktas; ne-string → klaida per esamą konfigo klaidų kelią; testas abiem atvejams.
- `spec-drift.ts`: `matchesScope` per `matchesAllowedPath`; testas `quality-gates-verify.test.ts` —
  `src/**/*.ts` scope su `src/a/b.ts` → `in_scope`; `docs/` prefiksas — kaip iki šiol.
- `release-proof.ts:159`: be `currentGitSha` → `skipped` + priežastis (ne `ok`); testas
  `release-readiness.test.ts`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `interfaces-cli-spec-tools.test.ts` (ne šio
scope) pina seną `preflight-limits` eksporto formą literalu — tada eksporto forma keičiama tik su
CLI autoriaus sutikimu.

## Neįtraukta
- AR-1 (wave sintezuoti task'ai be OpenSpec šaltinio), AN-1, AR-2 — task 192.
- `docs/spec-workflow.md` scope aprašas — docs autorius.
- `readiness-audit` usage eilučių palyginimas (C7) — CLI autorius.
