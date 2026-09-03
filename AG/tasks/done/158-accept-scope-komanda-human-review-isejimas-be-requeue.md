# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- Nėra.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/tasks/failai-scope-edit.ts` jau eksportuoja `acceptScopePaths` ir
`src/tests/domain-tasks-failai-scope-edit.test.ts` žalias — ALREADY_IMPLEMENTED: cituok eksporto
signatūrą ir testo pavadinimus.

## Tikslas
Grynas domain redaktorius, kuris task'o markdown'e į `## Failai` sekciją įrašo priimtą kelią ir
datuotą pastabą. Tai tekstinė dalis būsimos `accept-scope` komandos, uždarančios human-review
`rollback_failed` parkus (darbas žalias, bet vienas kelias nebuvo `## Failai` sąraše) be requeue.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/failai-scope-edit.ts`
- `src/tests/domain-tasks-failai-scope-edit.test.ts`

Draudžiama:
- `src/domain/tasks/allowed-paths.ts`
- `src/domain/tasks/etalonas-rules.ts`
- `src/interfaces/cli/task-queue/requeue.ts`
- `src/composition/cli/commands-tasks.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Sukurk gryną `acceptScopePaths(markdown, paths, note)` → `ok(newMarkdown)` / `err`: jokio `node:`
  importo, jokio IO, data perduodama argumentu (ne `Date.now()` viduje).
- Datuota `> ` pastaba įterpiama tuoj po `## Failai` antraštės, PRIEŠ `Leidžiama:` (parseris
  `src/domain/tasks/allowed-paths.ts:50-57` ten jos nemato); keliai pridedami `Leidžiama:` sąrašo
  gale forma `- \`kelias\``; idempotentiška — esamas kelias nekartojamas; be `## Failai` — `err`.
- Testai: pastaba virš `Leidžiama:`, kelias sąrašo gale, pakartotinis kvietimas nieko nekeičia,
  trūkstama sekcija → `err`, o rezultatas praeina `validateTaskAgainstEtalonas`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Privaloma nurodyta agentų grandinė. Commit'ink, kai abi patikros žalios. Stop ir klausk, jei
pastabos įterpimas reikalautų keisti `allowed-paths.ts` parserį — tada keičiasi kontraktas, ne
redaktorius.

## Neįtraukta
- CLI komanda `accept-scope.ts` ir bucket'o perkėlimas — kita dalis.
- Registras `commands-tasks.ts` ir README „Task queue" eilutė — vėlesnės dalys.
- Šakos merge iš CLI (git mutacija) — operatoriaus darbas.
