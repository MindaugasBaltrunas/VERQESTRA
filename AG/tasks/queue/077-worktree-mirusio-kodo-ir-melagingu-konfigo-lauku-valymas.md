# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 operatoriaus užsakytas w1/w2 auditas — mirusio kodo ir klaidinančio konfigo valymas (P1/P2); trynimai yra šio cleanup esmė

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 073-registraciju-valymas-visuose-worktree-salinimo-keliuose

## Žingsnis 0 — ar jau įgyvendinta?
Jei `WorktreePolicy` turi tik realiai skaitomus laukus, o
`primary-claim-unsupported` šakos ir `planParallelWorktrees` kode nebėra —
ALREADY_IMPLEMENTED su įrodymu.

## Tikslas
Audito mirusio kodo radiniai (2026-08-29), visi su „neturi nė vieno
produkcinio skaitytojo" įrodymu:

1. **Melagingi politikos laukai** —
   `src/application/scheduling/worktree-policy.ts:25-30`: `root:
   ".ag-worktrees"`, `branchPrefix: "ag-task"`, `pathPrefix: "task"`
   prieštarauja gyvoms konstantoms (`.ag/worktrees`, `ag/worker` —
   `worktree-layout.ts:11,14`) ir NIEKUR neskaitomi (abu kvietėjai ima tik
   `.enabled`). Konfigas meluoja operatoriui apie tai, ką jis valdo.
   Šalinami iš tipo, parserio, default'o IR iš
   `templates/vq/config/worktree-policy.json` bei gyvo
   `vq/config/worktree-policy.json` (lieka tik `enabled`).
2. **Nepasiekiama `primary-claim-unsupported` šaka** —
   `src/application/scheduling/worker-pool-plan.ts:278-288`: sąlyga
   reikalauja task'o vienu metu būti ir slots, ir rejected su
   missing-lease — topologiškai neįmanoma (log: 137/137 atsisakymų
   `hard-cap`, šios priežasties 0). Šalinama šaka, priežasties enum narys
   ir `PRIMARY_SLOT_CLAIM_SUPPORTED` mechanizmas
   (`wave-provisioning.ts:100`), jei architect'as patvirtina, kad jis
   neturi kito skaitytojo.
3. **`planParallelWorktrees`** (`worktree-layout.ts:98`) — nulis
   produkcinių kvietėjų, gyvas tik teste. Šalinamas su savo testu.
4. **Write-only karantinas** — `readWorktreeQuarantine`
   (`worktree-owner.ts:107`) neturi produkcinio skaitytojo: arba
   prijungiamas prie orphan reaper'io ataskaitos (karantinuotos kopijos
   tampa matomos), arba šalinama visa pora su `quarantineWorktree` —
   architect'o sprendimas su pagrindimu ataskaitoje.
5. **Nepasiekiamas sargas** `worker-integration.ts:180`
   (`live.length === 0`) — pakeisti komentaru arba assert'u, kuris
   įvardija nepasiekiamumą, vietoj klaidinančios „gyvos" šakos.

Pagal CLAUDE.md: šalinama tik ĮRODŽIUS nenaudojimą — kiekvienam punktui
grep įrodymas ataskaitoje.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/worktree-policy.ts`
- `src/application/scheduling/worker-pool-plan.ts`
- `src/application/scheduling/wave-provisioning.ts`
- `src/application/scheduling/worker-integration.ts`
- `src/infrastructure/git/worktrees/worktree-layout.ts`
- `src/infrastructure/git/worktrees/worktree-owner.ts`
- `templates/vq/config/worktree-policy.json`
- `vq/config/worktree-policy.json` (TIK laukų šalinimas; `enabled` reikšmė
  NEkeičiama)
- `src/tests/git-rules.test.ts`
- `src/tests/infrastructure-worktrees.test.ts`
- `src/tests/scheduling-worker-pool.test.ts` (numatomas; jei testas gyvena
  kitur — tas failas vietoje šio, įrašyti į ataskaitą)
- `src/tests/composition-wave-scheduler-adapters.test.ts`

Draudžiama:
- `vq/config/worktree-policy.json` `enabled` reikšmės keitimas
  (operatoriaus sprendimas, ne cleanup)
- `src/tests/dead-export-gate.test.ts` (varto ribos — atskira diskusija)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: patvirtinti kiekvieno šalinimo saugumą grep'u; karantino
  poros sprendimas (prijungti vs šalinti).
- Coder: šalinimai + parserio/template suderinimas.
- Tester: politikos failas tik su `enabled` parsinamas; senas failas su
  papildomais laukais NElūžta (pereinamumas — pertekliniai laukai
  ignoruojami su įspėjimu).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei kuris nors „miręs"
simbolis pasirodo turįs gyvą kvietėją.

## Neįtraukta
`dead-export-gate` varto ribų keitimas (test-only kvietėjai — by design).
Zombie `.git/worktrees/operator-restore-037a` (rankinis operatoriaus
valymas: `git worktree remove .claude/worktrees/operator-restore-037a`
arba `git worktree prune` po katalogo pašalinimo). `enabled` perjungimas.
