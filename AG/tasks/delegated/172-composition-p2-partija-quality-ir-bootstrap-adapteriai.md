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
Jei `src/composition/quality/adapters.ts` `qualityGatesPorts` neturi `projectRoot = process.cwd()`
default'o, `src/composition/quality/final-audit-adapters.ts` nebeturi savo `listFilesRecursive`
BFS (61-71) ir `releaseCheckFs` gyvena viename faile, o `src/composition/runtime/bootstrap-adapters.ts`
`rollbackCleanUntracked` skaito ir `<runtimeRoot>/config/commands.env` bei nebeturi lokalaus
`commandExists` (161-169) — ALREADY_IMPLEMENTED: cituok keturias vietas.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 „Loop" pabaiga ir Dk2;
pilna ataskaita `audit-composition.md` P2-1/P2-2/P2-4/P2-8):
- `quality/adapters.ts:120` `qualityGatesPorts(runtimeRoot, projectRoot = process.cwd())` pažeidžia
  `composition/runtime/context.ts:92` invariantą (vienintelė vieta, skaitanti `process.cwd()`); visi
  4 kvietėjai (`commands-audit.ts:98`, `empty-queue-adapters.ts:77`,
  `release-check-adapters.ts:104`) projectRoot paduoda — default'as yra latentiniai spąstai hook'ų
  kontekstui, kur cwd yra worktree.
- Du `ReleaseCheckFsPort` adapteriai: `final-audit-adapters.ts:61-79` (savas BFS, nerūšiuotas,
  eksportuotas `releaseCheckFs`) vs `release-check-adapters.ts:65-70`
  (`nodeFsAdapter.listFilesRecursive`, rūšiuotas) — dvi kopijos tam pačiam hash įėjimui.
- Dk2 ✓: `AG_ROLLBACK_CLEAN` šablone `templates/vq/config/commands.env` („set to 1"), bet
  `bootstrap-adapters.ts:245-248` skaito tik `process.env`; `commands.env` krautuvai
  (`parseEnvFile` kvietėjai) ima tik `MAX_RETRIES_PER_ERROR` ir `AG_UI_PORT` — operatoriaus įrašas
  faile nieko nedaro.
- `bootstrap-adapters.ts:161-169` `commandExists` dubliuoja `run-process.ts:314`
  `commandExists` su silpnesniu quoting'u (`command -v ${command}` interpoliacija vs `"$1"`).

Kryptis: default'as šalinamas (kvietėjai jau teisingi), vienas FS portas, `commands.env` skaitymas
per tą patį `parseEnvFile` kaip kiti raktai, viena `commandExists` realizacija.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/quality/adapters.ts` (120)
- `src/composition/quality/final-audit-adapters.ts` (61-79)
- `src/composition/quality/release-check-adapters.ts` (65-70 — vienas eksportuotas portas)
- `src/composition/runtime/bootstrap-adapters.ts` (161-169, 245-248, `rollbackStablePorts` 251)
- `src/tests/composition-quality-adapters.test.ts` (numatomas naujas; iki šiol `quality/adapters.ts` ir abu release-check FS adapteriai be testo — audito T5)
- `src/tests/composition-bootstrap-adapters.test.ts` (numatomas naujas; `bootstrap-adapters.ts` be testo — audito T5)

Draudžiama:
- `src/infrastructure/process/run-process.ts` (`commandExists` importuojamas, nekeičiamas)
- `src/interfaces/http/ui-port-store.ts` (`parseEnvFile` importuojamas, nekeičiamas)
- `src/composition/cli/commands-ops.ts` (kvietėjai nekinta — 164/168 scope)
- `src/composition/cli/commands-audit.ts`
- `src/composition/loop/empty-queue-adapters.ts`
- `src/composition/runtime/integration-adapters.ts` (175 scope)
- `templates/**`
- `docs/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `quality/adapters.ts:120`: `projectRoot: string` privalomas; komentare nuoroda į `context.ts:92`.
- `release-check-adapters.ts`: `releaseCheckFs` eksportuojamas (rūšiuota
  `nodeFsAdapter.listFilesRecursive` versija); `final-audit-adapters.ts` savo BFS ir eksportą
  šalina, importuoja bendrą. `dead-export-gate` naujam eksportui turi kvietėją (final-audit), tad
  papildomų `KNOWN_*` įrašų nereikia — patikrinti, kad senas `final-audit-adapters.ts#releaseCheckFs`
  neturėjo įrašo.
- `bootstrap-adapters.ts`: `rollbackCleanUntracked` gauna `commands.env` turinį (skaitomas
  `rollbackStablePorts` konstravimo metu per `parseEnvFile`), pirmenybė `process.env`, paskui failas,
  ta pati `1`/`true` semantika; lokalus `commandExists` pakeičiamas `run-process.commandExists`.
- Testai: naujas `composition-quality-adapters.test.ts` — abu release-check vartotojai gauna TĄ PATĮ
  porto objektą ir rūšiuotą sąrašą (tmp katalogas); naujas `composition-bootstrap-adapters.test.ts` —
  `AG_ROLLBACK_CLEAN=1` faile be env → `cleanUntracked: true`, env `0` nugali failo `1`, nieko → false;
  `commandExists` per bendrą realizaciją (komandos su tarpu nesukelia shell interpoliacijos).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `rollbackStablePorts` sinchroninis konstravimas
neleidžia perskaityti `commands.env` be viešo kontrakto keitimo (`RollbackStablePorts` tipas) —
tada `cleanUntracked` tampa lazy funkcija, o ne reikšme, ir tai sprendžia interfaces autorius.

## Neįtraukta
- `templates/vq/config/commands.env` tekstas ir `CLAUDE_COMMAND` (`models.env:9`, 0 skaitytojų) —
  šablonų autorius.
- Mirę `mcp-policy/browser-policy/research-policy.json` šablonai (P2-3) — šablonų autorius.
- Benchmark celės aprūpinimas iš `packageRoot()` (P2-7) — task 175.
- Sprendimo nuosavybės taisyklė ir dinaminis git importas — task 173.
