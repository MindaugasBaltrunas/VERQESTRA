# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/cli/audit/security-verify.ts` su `--json` spausdina `JSON.stringify(result)`,
`src/interfaces/cli/reports/report.ts` `reportCommand` parsina `--recent <n>`/`--recent=<n>` į
`options.recentLimit`, o `src/interfaces/cli/audit/learning.ts` flag'us skaito per bendrą
`flagValue` (abi formos) — ALREADY_IMPLEMENTED: cituok eilutes ir testus
`src/tests/interfaces-cli-audit.test.ts`, `src/tests/interfaces-cli-reports.test.ts`.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-C7 ir P2 CLI (2026-09-05),
`audit-cli.md` F10, F12, F13, F15; `audit-docs.md` 8, 10, 12:
- `security-verify.ts:14-27` — `--json` dokumentuotas (README:166, `commands-audit.ts:66`),
  bet niekada nespausdinamas; application `securityVerify` `--` argumentus tik atfiltruoja.
- `report.ts:345-351` — `args` naudojami tik `--json`; `recentLimit` ateina tik per `options`,
  kurių composition nepaduoda → `verqestra report --recent 50` visada rodo 5 (README:177).
- `learning.ts:26,100,107-109` — subkomandos `record|query|summary|approve|reject`, README:143
  ir `commands-spec.ts:52` rodo `<list|approve|reject> [id]`; lokalus `argValue` priima tik
  tarpo formą (vienas iš 4 skirtingų parserių scope'e).
Kodo pusė čia: JSON išvestys ir `--recent`; `learning` usage tekstas ir parseris; README/registro
eilutės — drift 217.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/audit/security-verify.ts`
- `src/interfaces/cli/audit/learning.ts`
- `src/interfaces/cli/reports/report.ts`
- `src/tests/interfaces-cli-audit.test.ts`
- `src/tests/interfaces-cli-reports.test.ts`

Draudžiama:
- `src/application/quality-gates/security-verify.ts`
- `src/interfaces/cli/audit/audit-director.ts` (task 219)
- `src/interfaces/cli/audit/quality-gates.ts` (task 209)
- `src/composition/cli/commands-audit.ts`
- `src/composition/cli/commands-spec.ts`
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `security-verify.ts`: `args.includes("--json")` → `io.out(JSON.stringify(result, null, 2))`
  vietoje tekstinių eilučių; exit kontraktas (`blocked` → 1) nekinta.
- `report.ts` `reportCommand`: `--recent <n>`/`--recent=<n>` → `recentLimit` (teigiamas
  sveikasis; kitaip usage į stderr, exit 2); `options.recentLimit` iš kvietėjo turi pirmumą
  tik jei paduotas eksplicitiškai.
- `learning.ts`: `argValue`/`argValues` → `flagValue` iš `../spec/flag-value.js` (abi formos;
  `argValues` kartojamiems `--label`/`--evidence` lieka lokalus, bet priima ir `=` formą);
  usage eilutė (:100) rodo pilną sąrašą; nežinoma subkomanda → usage, exit 2 (kaip dabar).
- Testai: `security-verify --json` → valid JSON su `status`, `files`; `report --recent 2` →
  `recentOutcomes.length ≤ 2` (fake fs su 5 baigtimis), `--recent x` → 2; `learning query
  --task-id=0042` ≡ `--task-id 0042`; `learning list` → 2 su usage.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `SecurityVerifyResult` turi laukų, kurių
JSON serializacija nutekintų kelius už `projectRoot` (absoliučius) — tada JSON'e keliai
normalizuojami į santykinius prieš spausdinant.

## Neįtraukta
- README/registro `learning`, `report`, `security-verify` eilutės — drift 217.
- `quality-gates [scope]` — 209; `preflight --json` — 212.
- `learning list` kaip `query` alias'as — sąmoningai ne: dokumentacija taisoma pagal kodą.
