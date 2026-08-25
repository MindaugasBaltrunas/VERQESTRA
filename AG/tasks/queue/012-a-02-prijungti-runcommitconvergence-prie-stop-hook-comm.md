# Task

## Spec source
openspec/changes/verqestra-backlog-v1 — tasks.md eilutė „Automatizuoti project status ir converge perleidimą po kiekvieno commit'o su telemetry įrašu". Tai 2 dalis iš 2 (use-case jau egzistuoja `src/application/release-readiness/commit-convergence.ts`).

## Tikslas
Surišti `runCommitConvergence` realiais portais composition sluoksnyje ir iškviesti jį po sėkmingo commit'o Stop hook kelyje, kad mechanizmas turėtų produkcinį kvietėją.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer

## Failai
Leidžiama:
- `src/composition/quality/commit-convergence-adapters.ts`
- `src/composition/hooks/stop-adapters.ts`
- `src/tests/composition-quality-commit-convergence.test.ts`

Draudžiama:
- `src/application/**`
- `src/domain/**`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- PASTABA (2026-08-25): šis failas perkeltas iš klaidingo `AG/tasks/tasks/queue/` kelio
  (dvigubas „tasks"), kuriame split'o vaikas jį paliko ir kuriame loop'as jo niekada
  nepamatytų. Senoji kopija paliekama trynimui commit'o metu; turinys nepakeistas.
- Parašyti `src/composition/quality/commit-convergence-adapters.ts`: realūs portai (project status, converge, telemetry failo rašymas po `vq/state/`, laikrodis) pagal `src/composition/quality/readiness-adapters.ts` stilių.
- Iškviesti `runCommitConvergence` `src/composition/hooks/stop-adapters.ts` po sėkmingo `commitAndPush` (eil. ~71) taip, kad convergence klaida NEnutrauktų commit'o — ji tik patenka į telemetry.
- Padengti `src/tests/composition-quality-commit-convergence.test.ts`: adapteriai surišti, telemetry įrašas atsiranda, commit'as išlieka sėkmingas kai convergence krenta.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink iš karto, kai abi patikros žalios. Sustok ir klausk, jei wiring reikalautų keisti `src/application/**` kontraktą arba silpninti `src/tests/dead-export-gate.test.ts`.

## Neįtraukta
- Naujų portų pridėjimas application sluoksnyje.
- Kitų quality vartų perrašymas.
- LLM kvietimai, queue loop vykdymas, MCP/vector DB integracijos.
