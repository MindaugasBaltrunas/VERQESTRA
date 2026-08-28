# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `waveWorktreePort.policyEnabled()` skaito worktree politiką iš TO PATIES
katalogo, į kurį ją deda `install` šablonai (`templates/vq/config/
worktree-policy.json` → `vq/config/`), arba install šablonas perkeltas į
`templates/AG/config/` — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-27 GeoGravity diegime rasta konfigo kelių skilimo klaida:
`composition/loop/wave-scheduler-adapters.ts:110-113` politiką skaito iš
`path.join(agRoot, "config", "worktree-policy.json")`, kur `agRoot` =
`<project>/AG` (`composition/runtime/context.ts:20,42`). Bet `verqestra
install` šablonas failą deda į `vq/config/worktree-policy.json`
(`templates/vq/config/`). Operatorius įjungia `enabled:true` vq/config faile,
o loop'as amžinai mato default `enabled:false` iš neegzistuojančio
`AG/config/` — `SLOT PROVISION SKIP: worktree politika išjungta`, antras
worker slot'as niekada nepakyla. Simptomas realiame diegime patvirtintas
(GeoGravity orchestrator.log 2026-08-27 20:22).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/wave-scheduler-adapters.ts`
- `src/tests/composition-wave-scheduler-adapters.test.ts` (numatomas naujas)
- `src/tests/scheduling-wave-provisioning.test.ts`
- `templates/vq/config/worktree-policy.json`

Draudžiama:
- `src/application/scheduling/worktree-policy.ts` (parseris nekaltas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect sprendimas: (A) skaityti iš `runtimeRoot/config` (vq/config —
  suderinta su install šablonu ir visomis kitomis politikomis, kurias krauna
  `policyConfigFs` iš runtimeRoot) ARBA (B) fallback grandinė
  `AG/config` → `vq/config`. Rekomenduojama (A) — visos kitos politikos
  gyvena vq/config.
- Testas: politika su `enabled:true` vq/config'e → `policyEnabled()` true;
  failo nebuvimas → default false.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios.

## Neįtraukta
Kitų politikų keliai (jie jau eina per runtimeRoot). Worktree kūrimo logika.
