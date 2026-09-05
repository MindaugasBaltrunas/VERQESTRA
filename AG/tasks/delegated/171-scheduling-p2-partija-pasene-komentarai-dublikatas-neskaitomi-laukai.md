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
Jei `src/application/scheduling/scope-lock-store.ts` nebeturi lokalaus `SCOPE_LOCK_KINDS` (38-45),
o importuoja iš `domain/scheduling`, `src/application/scheduling/worker-pool-plan.ts`
`WorkerPoolResolution` nebeturi laukų `continuing/succeeded_task_ids/failed_task_ids/integration_ready`
(arba jie turi produkcinį skaitytoją — grep per `src` be `src/tests`), o `index.ts:23-24` ir
`worker-lease-store.ts:333` komentarai atitinka kodą — ALREADY_IMPLEMENTED: cituok visas keturias
vietas.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 „Loop" ir pilna ataskaita
`audit-loop-core.md` P2), keturi to paties katalogo radiniai:
- `worker-lease-store.ts:333` komentaras „nenuimti lock'ai kabo iki TTL (15 min)" —
  `DEFAULT_SCOPE_LOCK_TTL_MS` (`scope-lock-store.ts:36`) yra 15 min, bet scope lock'ai išduodami
  kartu su lease, kurio TTL 3 h (`loop-runtime-config.ts:13`); operatorius skaito neteisingą laiką.
- `scheduling/index.ts:23-24` komentaras apie `GitCommandPlan`, kurį „vykdo infrastructure/git
  runGitPlan" — `runGitPlan` pašalintas, komentaras pasenęs.
- `scope-lock-store.ts:38-45` lokalus `SCOPE_LOCK_KINDS` — `domain/scheduling` tą patį sąrašą jau
  eksportuoja (audito „Dublikatai": `SCOPE_LOCK_KINDS ×2`); dvi kopijos išsiskirs pridėjus rūšį.
- `worker-pool-plan.ts:293-304` `WorkerPoolResolution` laukai `continuing`, `succeeded_task_ids`,
  `failed_task_ids`, `integration_ready` produkcijoje neskaitomi (audito „Negyvos šakos"); JSDoc
  žada „šaka blokuojama `collectBlockedBranch`", kurio kvietėjas jų neima. Tikrina tik
  `scheduling-pool.test.ts:178-185`.

Kryptis: komentarai — į faktą; dublikatas — importas iš domain (domain failas neliečiamas);
neskaitomi laukai — šalinami su testų atnaujinimu (CLAUDE.md: miręs kodas šalinamas įrodžius grep'u).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/worker-lease-store.ts` (332-334 komentaras)
- `src/application/scheduling/index.ts` (23-24 komentaras)
- `src/application/scheduling/scope-lock-store.ts` (38-45 dublikatas)
- `src/application/scheduling/worker-pool-plan.ts` (293-304 `WorkerPoolResolution`)
- `src/tests/scheduling-stores.test.ts` (importuoja `scheduling/index`)
- `src/tests/scheduling-wave-provisioning.test.ts` (importuoja `scope-lock-store`)
- `src/tests/scheduling-pool.test.ts` (178-185 pina šalinamus laukus)

Draudžiama:
- `src/domain/scheduling/scope-lock-rules.ts` (kito autoriaus scope — tik importuojamas)
- `src/application/scheduling/wave-scheduler.ts` (166 scope)
- `src/application/scheduling/wave-pool-planning.ts` (166 scope)
- `src/application/scheduling/wave-refill.ts` (174 scope)
- `src/application/scheduling/wave-dispatch.ts` (174 scope)
- `src/application/scheduling/loop-cycle.ts` (169 scope)
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `worker-lease-store.ts:332-334`: komentaras cituoja konstantą (`WAVE_SLOT_LEASE_TTL_MS` arba
  `DEFAULT_SCOPE_LOCK_TTL_MS` — tą, kuri REALIAI taikoma per `provisionSlotLease` išduotiems
  lock'ams; patikrinti `releaseScopeLocksInStore`/`acquire` kelią, ne spėti), be skaičiaus tekste.
- `index.ts:23-24`: komentaras aprašo esamą `worktree-policy` paskirtį be `runGitPlan`.
- `scope-lock-store.ts`: `SCOPE_LOCK_KINDS` importuojamas iš `../../domain/scheduling/index.js`;
  jei domain eksportuoja kitu vardu — naudoti jį, ne kurti alias'ą.
- `worker-pool-plan.ts`: laukai šalinami iš `WorkerPoolResolution` ir `resolveWorkerPool`
  rezultato; jei bent vienas turi produkcinį skaitytoją — palikti TIK jį ir įrašyti į ataskaitą.
  `scheduling-pool.test.ts:178-185` asercijos atnaujinamos (`release_lease_ids`/`reason` lieka).
- Testai: `scheduling-wave-provisioning.test.ts` (scope lock rūšys po importo) ir
  `scheduling-stores.test.ts` lieka žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `SCOPE_LOCK_KINDS` domain versija skiriasi
turiniu nuo lokalios (ne tik vieta) — tada tai ne dublikatas, o dvi taisyklės, ir sprendimas
priklauso `scope-lock-rules.ts` autoriui.

## Neįtraukta
- `commands-ops.ts:365` `loop-guard` atlaisvina TTL pasibaigusius lease'us, nors README sako „be
  loop'o starto" — README kito autoriaus; kodas 164 scope.
- README „timeout aborts the loop" vs pasikartojantis timeout → human-review/split — dokumentacija.
- `wave-refill.ts:200-206` ir `wave-dispatch.ts:146` — task 174.
- `WAVE_SLOT_LEASE_TTL_MS` reikšmė — task 170.
