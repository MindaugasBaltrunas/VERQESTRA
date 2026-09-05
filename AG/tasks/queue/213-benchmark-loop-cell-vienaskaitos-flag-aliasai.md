# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/cli/benchmark/benchmark-loop-cell.ts` `parseLoopCellArgs` priima
`--allowed-path <p>` ir `--check <cmd>` (kartojamus) kaip `--allowed-paths`/`--checks`
papildymą ir tai tvirtina `src/tests/interfaces-cli-benchmark-loop-cell.test.ts` —
ALREADY_IMPLEMENTED: cituok alias'ų šaką ir testą.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-C6 (2026-09-05), `audit-cli.md` F7,
`audit-docs.md` 5: registras `commands-integrations.ts:57` ir `README.md:219` skelbia
`--allowed-path <p> [--check <cmd>]`, o `benchmark-loop-cell.ts:44-49,122-127` reikalauja
`--allowed-paths <a|b>` ir `--checks <a|b>` (daugiskaita, `|` skirtukas): `... --allowed-path
src/a.js` → `--allowed-paths must name at least one path`, exit 2. Composition
`agLoopInvocationTemplate` naudoja teisingus vardus, tad benchmark paketas veikia; rankinis
operatorius pagal README — ne.

Sprendimas: parseris priima ABI formas — daugiskaitos `|`-sąrašą (kanoninė, dėl fiksuoto
invocation vektoriaus, :36-41) ir kartojamus vienaskaitos `--allowed-path`/`--check`;
reikšmės sujungiamos. Vienintelio `Map` „paskutinis laimi" elgesys keičiamas į kaupimą tik
šiems dviem raktams. Kitas kelias (README perrašyti į daugiskaitą) atmestas: vienaskaitos
forma yra natūrali rankiniam paleidimui, o kaupimas nieko nekainuoja.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/benchmark/benchmark-loop-cell.ts`
- `src/tests/interfaces-cli-benchmark-loop-cell.test.ts`

Draudžiama:
- `src/composition/cli/commands-integrations.ts` (usage — drift 217)
- `src/tests/benchmark-loop-cell-human-review.test.ts` (importuoja tik
  `CELL_HUMAN_REVIEW_APPROVAL`/`withCellHumanReviewApproval` — parserio nekeičia)
- `AG/benchmark/**`
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `parseLoopCellArgs`: `--allowed-path <p>` → pridedamas prie `allowed-paths` sąrašo;
  `--check <cmd>` → prie `checks`; kartojami leidžiami; daugiskaitos forma toliau skaidoma
  per `|`. Kiti raktai lieka „vienas kartas" (pakartotas `--model` → klaida arba paskutinis —
  palikti esamą elgesį).
- `USAGE` tekste (:44-49) parodyti abi formas.
- Testai: `--allowed-path a --allowed-path b` ≡ `--allowed-paths "a|b"`; mišri forma
  sujungiama; `--check` be `--checks` veikia; esami klaidų atvejai (trūksta `--allowed-paths`,
  neigiamas `--step-limit`) nepakitę.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
- Registro usage ir README 219 eilutė — drift 217 (abi formos bus dokumentuotos).
- `optimization-benchmark [--capture|--compare]` — kodas teisingas, klaidinga tik
  dokumentacija → drift 217.
- `benchmark <run|validate|report>` forma README:217 — drift 217.
