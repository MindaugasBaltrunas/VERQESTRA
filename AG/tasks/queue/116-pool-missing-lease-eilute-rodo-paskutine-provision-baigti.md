# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 114-provision-nesekme-nebesudegina-indekso-be-pakaitalo

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/wave-pool-planning.ts` `WORKER POOL` eilutės
rejections dalis (dabar 104-107 eil.) prie `missing-lease` įrašo prideda
paskutinio provision bandymo baigtį (pvz. worktree SKIP priežastį) —
ALREADY_IMPLEMENTED: cituok praturtintos eilutės formavimo kodą ir testą
kaip įrodymą.

## Tikslas
W1/w2 slot'ų audito P3 (2026-09-01): `missing-lease` pool eilutė slepia
tikrąją priežastį — operatorius buvo išsiųstas ieškoti lease'ų, nors problema
buvo gitignore. Mechanizmas patikrintas: admission
(`worker-pool-admission.ts:165`) grąžina statinį detail „antram workeriui
reikalingas worker lease"; `WORKER POOL` eilutę formuoja
`wave-pool-planning.ts:104-107` — `pool.rejected` sujungiamas į
`task: reason — detail` be jokio konteksto, KODĖL lease neatsirado. TIKROJI
priežastis (pvz. „SLOT PROVISION SKIP: worktree šaknis nėra gitignore'inta",
`wave-provisioning.ts:185-188`) log'e matoma tik ankstesnėje atskiroje
eilutėje, kurios operatorius su pool eilute nesusieja. Provision bandymai
(`provisionMissingSlotLeases`) įvyksta 79 eil. — PRIEŠ pool eilutės rašymą
103-115 eil., tad baigtys tuo momentu jau žinomos ir gali būti įpintos.
Sprendimas: `provisionSlotLease` nesėkmės baigtis (SKIP/CONFLICT priežastis)
surenkama per task_id ir pool eilutėje prie atitinkamo `missing-lease` įrašo
pridedama kaip uodega (pvz. „… — paskutinis provision bandymas: worktree
šaknis nėra gitignore'inta"). Admission'o statinis tekstas gali likti —
kontekstą prideda planavimo sluoksnis, kuris jį turi.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/wave-pool-planning.ts`
- `src/application/scheduling/wave-provisioning.ts` (nesėkmės baigties
  iškėlimas kvietėjui — po 114 pakeitimų)
- `src/tests/scheduling-wave-inputs.test.ts`
- `src/tests/scheduling-wave-provisioning.test.ts`
- `src/tests/scheduling-wave-integration-coordinator.test.ts` (2026-09-01
  parkas „outside allowed paths": čia gyvena WaveProvisioningCoordinator
  stub'as su provisionMissingSlotLeases — kontrakto formos keitimas jį
  liečia; pagrindime backtick'ų nėra sąmoningai — parseris tęstinių eilučių
  tokenus skaičiuoja kaip failus, 2026-09-02 11:08 parkas „context files 10 > 8")
- `src/tests/scheduling-wave-scheduler.test.ts` (2026-09-01 parkas: tas pats
  WaveProvisioningCoordinator stub'as lūžta keičiant
  provisionMissingSlotLeases grąžinimo formą)

Draudžiama:
- `src/application/scheduling/worker-pool-admission.ts` (statinis
  missing-lease detail lieka — kontekstas pridedamas planavimo sluoksnyje)
- `src/application/scheduling/worker-pool-plan.ts` (113 scope)
- `src/interfaces/http/ui-waves-view.ts` (`last_rejections` kontrakto forma
  nekinta; jei praturtintas detail į jį nuteka natūraliai per tą patį lauką —
  tai leidžiama pasekmė, ne kontrakto keitimas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Ankstesnio bandymo darbas išsaugotas:
  `refs/verqestra/preserved/2c69878b8f1b241bab294084ca9821ea87756ca4`
  (bazė `7e9527e`, 6 keliai — visi šios Leidžiamos; įrašas
  `vq/state/rollback-preserved/116-pool-missing-lease-eilute-rodo-paskutine-provision-baigti.json`).
  2026-09-01 20:14 parkavimo priežastis buvo TIK du testų failai už tuometinės
  Leidžiamos ribų (`scheduling-wave-integration-coordinator.test.ts`,
  `scheduling-wave-scheduler.test.ts`) — dabar jie įtraukti. Atkurk išsaugotą
  darbą ir tęsk nuo jo, ne nuo nulio.
- `wave-provisioning.ts`: `provisionSlotLease` nesėkmių priežastys tampa
  prieinamos kvietėjui (pvz. `provisionMissingSlotLeases` grąžina arba
  kaupia `Map<task_id, paskutinė baigtis>`; forma — vykdytojo sprendimas,
  suderintas su 114 pakaitalo logika: fiksuojama PASKUTINIO bandymo baigtis).
- `wave-pool-planning.ts` (104-107 eil.): formuojant rejections eilutę,
  `missing-lease` įrašams pridedama turima provision baigtis; įrašams be
  bandymo (provision iki jų nepriėjo) — nieko nepridedama, eilutės formatas
  kitiems reason kodams nekinta.
- Testų lūkestis: (1) regresija — kandidatas atmestas `missing-lease`, o
  provision SKIP'ino dėl gitignore → `WORKER POOL` eilutėje prie to task'o
  matoma gitignore priežastis; (2) missing-lease be provision bandymo →
  eilutė kaip iki šiol; (3) kitų reason kodų eilutės nepakitusios.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei baigties pernešimas
pareikalautų keisti `WavePoolPlanning` viešą kontraktą taip, kad lūžtų
svetimi kvietėjai už scheduling ribų.

## Neįtraukta
- Admission žinučių perrašymas (`worker-pool-admission.ts`) — statinis
  tekstas teisingas savo lygyje.
- UI `last_rejections` pateikimo keitimai — praturtintas tekstas nuteka per
  esamą lauką be formos keitimo.
- Hard-cap žinutė — task 113; pakaitalo logika — task 114 (ši
  priklausomybė).
