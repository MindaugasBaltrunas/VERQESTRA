# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/cli/audit/quality-gates.ts` `qualityGatesCommand` pirmą ne-`--` argumentą
paverčia `--scope <x>` prieš kviesdamas `runQualityGates` (arba atmeta jį su usage ir exit 2) ir
tai tvirtina testas `src/tests/interfaces-cli-quality-gates.test.ts` — ALREADY_IMPLEMENTED:
cituok pozicinio argumento apdorojimo eilutę ir testo pavadinimą.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-C1 (2026-09-05):
`src/interfaces/cli/audit/quality-gates.ts:37` paduoda `args` tiesiai į `runQualityGates`, o
`src/application/quality-gates/quality-gates.ts:68-76` `parseQualityScope` skaito TIK `--scope
<x>`/`--scope=<x>`. Registras `commands-audit.ts:93` ir `README.md:168` skelbia `[scope]`
pozicinį. `verqestra quality-gates milestone` → tyliai `scope: task`, spausdina `quality-gates
scope=task PASSED` ir įrašo `quality-gates-status.json` su `scope: task` — operatorius mano, kad
milestone vartai žali. Composition kviečia teisingai (`release-check-adapters.ts:104`
`["--scope","milestone"]`), tad loop'as sveikas; klaidinamas tik rankinis paleidimas.

Sprendimas gyvena INTERFACE adapteryje, ne application: `qualityGatesCommand` normalizuoja
argumentus — vienintelis pozicinis (`task|feature|milestone`) tampa `--scope <x>`, kai `--scope`
dar nepaduotas; pozicinis KARTU su `--scope` arba antras pozicinis → usage į stderr ir exit 2.
Application parseris nekeičiamas (jo scope — kito autoriaus).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/audit/quality-gates.ts`
- `src/tests/interfaces-cli-quality-gates.test.ts` (numatomas naujas; jei `qualityGatesCommand`
  jau testuojamas kitame faile — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/application/quality-gates/quality-gates.ts`
- `src/composition/cli/commands-audit.ts`
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `quality-gates.ts` (interfaces): prieš `runQualityGates` — `normalizeQualityGatesArgs(args)`:
  poziciniai = token'ai be `--` prefikso, kurie nėra `--scope` reikšmė; 0 pozicinių → args
  nekinta; 1 pozicinis be `--scope` → `["--scope", positional, ...rest]`; 1 pozicinis su
  `--scope` arba ≥2 poziciniai → `io.error("Usage: verqestra quality-gates [scope] [--json]
  [--no-memo]")`, `return 2` (jokio `runQualityGates` kvietimo, jokio statuso failo).
- Pozicinio reikšmė NEVALIDUOJAMA čia — nežinomą scope'ą atmeta `runQualityGates` kaip iki šiol.
- Testai per fake `QualityGatesPorts` (fiksuojantys, kokį scope gavo use case):
  `["milestone"]` → scope milestone; `["--scope","feature"]` nepakitęs; `["milestone","--json"]`
  → JSON su `scope: milestone`; `["milestone","--scope","task"]` → 2 be kvietimo;
  `["a","b"]` → 2.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `runQualityGates` kviečia
`parseQualityScope` taip, kad `--scope` po pozicinio išsikeitimo vis tiek nepasiekia
(pvz. skaito tik `args[0]`) — tada taisymas priklauso application sluoksniui ir šis task'as
parkuojamas su įrodymu.

## Neįtraukta
- `parseQualityScope` keitimas application sluoksnyje — ne šio task'o scope.
- Registro/README eilutės `[scope]` — nekinta (jos jau teisingos); drift task'as 217 jas
  tik sutikrina.
