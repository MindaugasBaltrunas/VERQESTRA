# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Pašalinti topologiškai nepasiekiamą atsisakymo šaką `worker-pool-plan.ts:278-288` (`primary-claim-unsupported`): sąlyga reikalauja to paties task'o vienu metu būti ir slots, ir rejected su missing-lease. Telemetrija patvirtina: 137/137 atsisakymų yra `hard-cap`, šios priežasties — 0. Kartu šalinamas priežasties enum narys ir konstanta `PRIMARY_SLOT_CLAIM_SUPPORTED` (`wave-provisioning.ts:100`) su savo skaitytojais.

## Agentai
PRIVALOMA grandinė (ta pati eilės tvarka, be praleidimų): `readme-guard -> architect -> coder -> reviewer -> tester`.

## Failai
Leidžiama:
- `src/application/scheduling/worker-pool-plan.ts`
- `src/application/scheduling/wave-provisioning.ts`
- `src/application/scheduling/wave-scheduler.ts`
- `src/tests/scheduling-pool.test.ts`
- `src/tests/scheduling-wave-provisioning.test.ts`
- `src/tests/composition-wave-scheduler-adapters.test.ts`

Draudžiama:
- `src/application/scheduling/worker-integration.ts`
- `src/infrastructure/git/worktrees/worktree-layout.ts`
- `src/tests/dead-export-gate.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: Grep'u surašyti VISUS `PRIMARY_SLOT_CLAIM_SUPPORTED` ir `primary_claim_supported`/`primaryClaimSupported` skaitytojus (žinomi: `wave-provisioning.ts:361`, `wave-scheduler.ts:216,235`) ir patvirtinti, kad konstanta niekur netampa `true`.
- Coder: pašalinti šaką, enum narį `"primary-claim-unsupported"`, konstantą ir jos parametrų kelią; likusi `planSlotProvisioning` semantika nekeičiama.
- Tester: pašalinti/perrašyti `scheduling-pool.test.ts:118` tvirtinimą; patikrinti, kad atsisakymo priežasčių aibė lieka pilna ir hard-cap kelias nepajudėjo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei atsiranda kelias, kuriame `PRIMARY_SLOT_CLAIM_SUPPORTED` gali būti `true`, arba jei šaka pasirodo pasiekiama.

## Neįtraukta
`dead-export-gate` varto ribų keitimas. `worktree-layout.ts`, `worktree-owner.ts` ir `worker-integration.ts` valymai — atskiri vaikai.
