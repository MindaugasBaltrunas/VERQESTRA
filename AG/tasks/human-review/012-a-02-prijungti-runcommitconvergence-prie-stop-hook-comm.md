# Task

## Spec source
openspec/changes/verqestra-backlog-v1 — tasks.md eilutė „Automatizuoti project status ir converge perleidimą po kiekvieno commit'o su telemetry įrašu". Tai 2 dalis iš 2 (use-case jau egzistuoja `src/application/release-readiness/commit-convergence.ts`).

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/quality/commit-convergence-adapters.ts` egzistuoja ir
eksportuoja `commitConvergencePorts` bei `recordCommitConvergence`,
`src/composition/hooks/stop-adapters.ts` juos importuoja (šiandien 28 eil.)
ir kviečia po sėkmingo commit'o (šiandien 84-85 eil., klaidų gaudyklė
`recordCommitConvergence` viduje), o
`src/tests/composition-quality-commit-convergence.test.ts` egzistuoja —
ALREADY_IMPLEMENTED: cituok importo ir kvietimo eilutes, adapterio
eksportus ir testo failo vardą kaip įrodymą. Patikrinta 2026-09-02 (Grep
`runCommitConvergence` / `recordCommitConvergence` per `src`): visos trys
sąlygos tenkinamos, o `vq/logs/hooks.log` rodo gyvą kvietimą
(`commit-convergence ce4a7bd…: project_status=issues converge=issues
issues=33`, 2026-09-01 21:05:19Z). Tikėtina baigtis — ALREADY_IMPLEMENTED
be kodo pakeitimų.

## Tikslas
Surišti `runCommitConvergence` realiais portais composition sluoksnyje ir
iškviesti jį po sėkmingo commit'o Stop hook kelyje, kad mechanizmas turėtų
produkcinį kvietėją.

Parkavimo istorija (`vq/logs/orchestrator.log`): 2026-09-01 05:59:12
preflight krito dėl `Existing-code task requires a fresh code index: code
index is stale`; po to retry sargas tris kartus (11:26, 15:46, 2026-09-02
05:18) grąžino task'ą į human-review vien dėl NEPAKITUSIO turinio
(`preflight-retry-without-change`, repeat=4) — darbas tuo metu jau buvo
kode, bet task'as nebuvo iš naujo įvertintas. Šis perrašymas keičia turinį
(retry sargo hash) ir nurodo Žingsnio 0 kelią. Jei preflight vėl kristų
dėl pasenusio kodo indekso — tai aplinkos, ne task'o problema: operatorius
perstato indeksą (`verqestra code-index build`), task'as nekeičiamas.

## Agentai
readme-guard -> coder -> reviewer

## Failai
Leidžiama:
- `src/composition/quality/commit-convergence-adapters.ts`
- `src/composition/hooks/stop-adapters.ts`
- `src/tests/composition-quality-commit-convergence.test.ts`

Draudžiama:
- `src/application/release-readiness/commit-convergence.ts` (use-case kontraktas nekinta)
- `src/domain/**`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Pirmiausia Žingsnis 0: jei visos trys sąlygos tenkinamos — ataskaita su
  citatomis ir jokių kodo pakeitimų.
- Tik jei kuri sąlyga netenkinama: `commit-convergence-adapters.ts` —
  realūs portai (project status, converge, telemetry failo rašymas po
  `vq/state/`, laikrodis) pagal `src/composition/quality/readiness-adapters.ts`
  stilių; `stop-adapters.ts` — kvietimas po sėkmingo `commitAndPush` taip,
  kad convergence klaida NEnutrauktų commit'o, o tik patektų į telemetry.
- Testų lūkestis (`composition-quality-commit-convergence.test.ts`):
  adapteriai surišti, telemetry įrašas atsiranda, commit'as išlieka
  sėkmingas, kai convergence krenta.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei wiring reikalautų
keisti `src/application/**` kontraktą arba silpninti
`src/tests/dead-export-gate.test.ts`.

## Neįtraukta
- Naujų portų pridėjimas application sluoksnyje.
- Kitų quality vartų perrašymas.
- Retry sargo (`preflight-retry-without-change`) elgesys, kai priežastis
  buvo aplinkos (kodo indekso) būsena, o ne task'o turinys — atskiro task'o
  klausimas, šis tik uždaro konkretų parką.
- LLM kvietimai, queue loop vykdymas, MCP/vector DB integracijos.
