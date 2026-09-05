# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 208-rollback-stable-atmeta-nezinomus-argumentus-ir-igyvendina-ref
- 209-quality-gates-pozicinis-scope-argumentas-veikia
- 210-dispatch-katalogo-argumentu-parseriai-abi-flag-formos
- 211-install-be-taikinio-diegia-i-projectroot
- 212-smoke-status-be-mutacijos-ir-bootstrap-admin-usage-exit-kodai
- 213-benchmark-loop-cell-vienaskaitos-flag-aliasai
- 214-openspec-reconcile-apply-numatytasis-rezimas-planas
- 215-security-verify-json-learning-usage-report-recent
- 216-like-cli-parseriai-claude-preflight-guard-task-generate-issue-import

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/readiness-command-sources.test.ts` turi testą, kuris kiekvienai README
„Main Commands" eilutei `verqestra <name> <usage>` randa registro `name: "<name>"` įrašą ir
lygina `usage` (placeholder'iai `<…>` normalizuoti), o README eilutės `rollback-stable`,
`install`, `learning`, `policy`, `optimization-benchmark`, `benchmark`, `codex-dispatch` jau
atitinka registrą — ALREADY_IMPLEMENTED: cituok testą ir eilutes.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P0-1, P1-C1…C7, P2 docs 28, 32
(2026-09-05); `audit-cli.md` F1–F7, F9–F14, F18; `audit-docs.md` 1–12, 28, 32. README „Main
Commands" ir registrai (`src/composition/cli/commands-*.ts`) skelbia 12 CLI eilučių, kurių
argumentai neatitinka handler'ių: `install [--dry-run]` (README:190, `commands-ops.ts:127`),
`openspec-reconcile [--apply]` (:147, `commands-spec.ts:95`), `rollback-stable [--task-scope]
[--ref <sha>]` (:193, `commands-ops.ts:165`), `optimization-benchmark [--capture|--compare]`
(:220, `commands-integrations.ts:64`; realiai `--baseline|--compare-baseline|--print-hash`),
`benchmark-loop-cell --allowed-path <p> [--check <cmd>]` (:219, :57), `dispatch --adapter
<kind>` (:199, `commands-ops.ts:372`), `quality-gates [scope]` (:168, `commands-audit.ts:93`),
`learning <list|approve|reject> [id]` (:143, `commands-spec.ts:52`; realiai
`record|query|summary|approve|reject`), `policy [list|propose ...]` (:174,
`commands-audit.ts:180`; realiai `show|propose|status`), `report [--recent <n>]` (:177),
`preflight --json` (:173), `security-verify --json` (:166). Plius `benchmark [--mode <mode>]`
(:217; realus paketo CLI `benchmark <run|validate|report> …`), `codex-dispatch <task-id>
[--adapter codex]` (:200, `commands-ops.ts:382`; `--context-pack <file>` privalomas codex
režime) ir `hook-post-bash-sync` (:234, `commands-hooks.ts:73`) — registruotas, bet niekur
nekviečiamas (`settings.json` kviečia `hook-post-bash`).

`readiness-audit` (`application/release-readiness/readiness-audit.ts:94-107`) lygina tik
komandų VARDUS, o `readiness-command-sources.test.ts` — tik sankirtos netuštumą, tad nė vieno
drifto vartas nemato. Šis task'as (a) perrašo README ir registro usage eilutes pagal GALUTINĮ
elgesį po 208–216 ir (b) išplečia vartą taip, kad usage eilutė README ↔ registras būtų
lyginama deterministiškai. Vartas gyvena TESTE (skaito realius failus), ne application —
application scope'as priklauso kitam autoriui.

## Agentai
readme-guard -> coder -> reviewer -> tester -> documenter

## Failai
Leidžiama:
- `README.md`
- `src/composition/cli/commands-ops.ts`
- `src/composition/cli/commands-audit.ts`
- `src/composition/cli/commands-spec.ts`
- `src/composition/cli/commands-integrations.ts`
- `src/composition/cli/commands-hooks.ts`
- `src/tests/readiness-command-sources.test.ts`
- `src/tests/composition-cli.test.ts`

Draudžiama:
- `src/application/release-readiness/readiness-audit.ts`
- `src/composition/quality/readiness-adapters.ts`
- `src/interfaces/cli/**` (elgesys jau pakeistas 208–216; čia tik dokumentacija ir registras)
- `docs/**` (task 222)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Registro usage eilutės pagal galutinį elgesį: `install` → `[<target-project-dir>]
  [--dry-run]`; `rollback-stable` → `[--allow-task-changes --task-id <id> [--run-id <id>]]
  [--ref <sha>]`; `optimization-benchmark` → `[--baseline|--compare-baseline|--print-hash]
  [--json]`; `benchmark-loop-cell` → `… --allowed-paths <a|b> [--checks <a|b>]` (vienaskaitos
  aliasai paminimi aprašyme); `benchmark` → `<run|validate|report> [--mode <mode>] [--json]`
  (patikrinti `AG/benchmark/src/interfaces/cli/benchmark-cli-help.ts`); `learning` →
  `[record|query|summary|approve|reject] [--json]`; `policy` → `[show|propose|status]
  [--json]`; `codex-dispatch` → `<task-id> [--adapter codex --context-pack <file>]`;
  `hook-post-bash-sync` aprašymas → „(neprijungtas pagal nutylėjimą — settings.json kviečia
  hook-post-bash)". Nepakitusios eilutės (`quality-gates [scope]`, `dispatch`, `preflight`,
  `security-verify`, `report`, `openspec-reconcile`) — nekeisti.
- `README.md` „Main Commands" ir hook lentelės: tos pačios eilutės anglų kalba; `smoke`
  „changes nothing" lieka (po 212 tiesa); `hook-post-bash-sync` eilutėje „not wired by
  default".
- `readiness-command-sources.test.ts`: naujas testas — iš README `## Main Commands` sekcijos
  surinkti `` `verqestra <name>[ <usage>]` `` (atkoduoti `\|` → `|`), iš registro failų —
  `name: "<name>"` + gretimą `usage: "…"`; normalizuoti placeholder'ius `<…>` → `<_>` (registre
  jie lietuviški: `<režimas>`, `<numeris>`), sutraukti tarpus; kiekvienai README komandai usage
  privalo sutapti; hook komandos (be usage) lyginamos tik vardu. Klaidos žinutė rodo abi
  eilutes.
- `composition-cli.test.ts`: jei help eilučių asercijos (:245) pina keičiamą usage —
  atnaujinti; kitaip nekeisti.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei README lentelės eilutė negali išreikšti
usage be lentelės struktūros keitimo (pvz. daugiaeilis `benchmark-loop-cell`), arba jei koks
nors iš 208–216 task'ų parkavosi human-review ir jo eilutė vis dar meluotų — tada tą eilutę
palikti senoje formoje ir įrašyti į ataskaitą.

## Neįtraukta
- `readiness-audit` application logikos išplėtimas iki usage palyginimo — kito autoriaus
  `src/application/**` scope; vartas čia gyvena teste.
- `README.md` ne-lentelės eilutės (exit 69, runtime keliai, env kintamieji, Stop hook'as,
  workspace nariai) — task 222 (priklauso nuo šio).
- Pastaba operatoriui: `src/composition/cli/commands-ops.ts` lygiagrečiai liečia kito autoriaus
  task'ai (163–177) — planuoklė serializuos pagal `## Failai`; priklausomybės į tuos id
  sąmoningai nedeklaruojamos.
