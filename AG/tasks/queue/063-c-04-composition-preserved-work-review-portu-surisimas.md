# Task

Pastaba (2026-08-28): pirmas bandymas krito preflight'e dėl aplinkos —
„code index rebuild did not produce a fresh index" (lenktynės su
lygiagrečiu procesu, ne task'o problema). Perleidžiama be turinio pakeitimų.

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 064-a-02-orphan-reaper-kviecia-registraciju-valyma-po-katal
- 064-b-03-provisioning-pries-git-worktree-add-isvalo-to-pati

## Tikslas
Surišti preserved work review portus su realiais adapteriais loop composition sluoksnyje, kad automatinė išsaugoto darbo peržiūra veiktų gyvame dispatch kelyje.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/preserved-work-adapters.ts`
- `src/composition/loop/command.ts`
- `src/tests/composition-preserved-work-wiring.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`
- `src/domain/**`
- `src/interfaces/**`

## Veiksmas
- Adapteryje surišk infrastruktūros preserved worktree materializavimą ir komandų paleidimą su application portu; jokios verslo logikos composition sluoksnyje.
- Prijunk adapterį prie `verify-task` kelio loop'o surišime, nekeisdamas kitų dispatch žingsnių.
- Testas: surišimas paduoda realų adapterį ir žalias preserved darbas praeina iki done su `PRESERVED-WORK-RECOVERED`; be adapterio elgesys nekinta.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok, jei prireiktų keisti public CLI kontraktą ar `package.json`.

## Neįtraukta
Timeout'o šaknies sprendimas, preserved ref'ų valymo politika, UI rodymas.
