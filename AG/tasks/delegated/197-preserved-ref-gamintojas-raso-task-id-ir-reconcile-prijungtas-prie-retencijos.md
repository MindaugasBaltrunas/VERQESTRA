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
Jei `src/infrastructure/git/rollback-scope.ts` `preserveTaskScope` `commit-tree` žinutė neša
`task=<id>` IR `reconcilePreservedRefs` (`preserved-ref-reconcile.ts`) turi kvietėją už `src/tests/`
ribų (Grep `reconcilePreservedRefs` per `src/**` be testų) — ALREADY_IMPLEMENTED: cituok žinutės
eilutę ir kvietėjo failą:eilutę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, I2 ✓; infrastructure F2).
Vienintelis `refs/verqestra/preserved/*` gamintojas `rollback-scope.ts:124` rašo FIKSUOTĄ žinutę
`"verqestra: preserved task scope"`, o `preserved-ref-reconcile.ts:29` `TASK_ID_PATTERN` ieško
`\btask=` → `reconcileOneRef` KIEKVIENĄ našlaitį verčia `task-id-not-found`. Be to
`reconcilePreservedRefs` neturi nė vieno composition kvietėjo (grep: tik
`infrastructure-preserved-ref-reconcile.test.ts:78-145`), o testas žinutę su `task=083-restored`
fabrikuoja pats (:75). Modulis 083-a-02 dvigubai negyvas: neprijungtas IR neveiktų prijungus.
Kryptis: (1) gamintojas rašo `verqestra: preserved task scope task=<id>` — id ateina per naują
neprivalomą `restoreTaskScope(root, stableRef, paths, options?: { taskId?: string })` argumentą, o be jo
skaitomas iš `<root>/vq/state/current-task-id` (tas pats tapatybės šaltinis, kurį šis failas jau naudoja
`readTaskScopePaths`, :239); (2) reconcile prijungiamas kaip PIRMAS `expirePreservedRefs` žingsnis
(`preserved-ref-retention.ts:173`) — retencija produkcijoje gyva (`composition/loop/command.ts:389`
`preservedRefRetention.expire`), tad tai vienintelė vieta, kur prijungimas veikia be composition
keitimo. Atmesta: prijungimas `composition/loop` — už šio task'o scope; trynimas — žr. `## Stop`.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/rollback-scope.ts` (`preserveTaskScope` žinutė, `restoreTaskScope` options)
- `src/infrastructure/git/preserved-ref-reconcile.ts`
- `src/infrastructure/git/preserved-ref-retention.ts` (`expirePreservedRefs` kviečia reconcile)
- `src/infrastructure/git/preserved-ref-record-model.ts` (numatomas naujas: `PreservedRefRecord`, `PRESERVED_REF_RECORD_DIRNAME` — importų ciklo reconcile↔retention išvengimui)
- `src/tests/infrastructure-preserved-ref-reconcile.test.ts`
- `src/tests/infrastructure-preserved-ref-retention.test.ts`

Draudžiama:
- `src/interfaces/cli/bootstrap/rollback-stable.ts` (portas `restoreTaskScope(root, ref, paths)` nekinta)
- `src/composition/runtime/bootstrap-adapters.ts`
- `src/composition/loop/preserved-work-adapters.ts`
- `src/composition/loop/command.ts`
- `src/tests/infrastructure-git.test.ts` (esami `restoreTaskScope` testai lieka žali be pakeitimų)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `preserved-ref-record-model.ts`: perkelti `PreservedRefRecord` ir `PRESERVED_REF_RECORD_DIRNAME`
  (dabar dubliuotas `retention.ts:24` ir `reconcile.ts:26`); abu moduliai importuoja iš modelio.
  Importų grafas lieka aciklinis (architecture-gates vartas tikrina ir type-only ryšius).
- `rollback-scope.ts` `preserveTaskScope(root, stableRef, paths, taskId?)`: žinutė
  `verqestra: preserved task scope task=<id>`, kai id yra; `restoreTaskScope` ketvirtas argumentas
  `{ taskId?: string }`; be jo — `current-task-id` iš `<root>/vq/state/` (`nodeFsAdapter.readTextFileIfExists`,
  trim); nė vieno nėra → žinutė be žymos (elgesys nepakitęs). Id sanitizuojamas iki `[A-Za-z0-9._-]+` —
  jis vėliau tampa failo vardu `rollback-preserved/<id>.json`.
- `preserved-ref-reconcile.ts`: ta pati sanitizacija parse pusėje (`task-id-invalid` priežastis).
- `preserved-ref-retention.ts` `expirePreservedRefs`: prieš `readPreservedRefRecords` kviesti
  `reconcilePreservedRefs(root, ports, { runtimeRoot })`; rezultatas grąžinamas papildomu neprivalomu
  lauku `reconciled?: PreservedRefReconcileResult` (esami `expired`/`kept` nekinta). Reconcile
  nesėkmė (git klaida) retencijos nestabdo — log eilutė per `ports.agLog`.
- Testai: reconcile testas ref'ą gamina per REALŲ `restoreTaskScope(…, { taskId })`, ne fabrikuotą
  `commit-tree` (fabrikuotas atvejis lieka tik `unattributed` keliui); `restoreTaskScope` be options ir
  su `vq/state/current-task-id` → žinutė su `task=`; be abiejų → `task-id-not-found`; retencijos testas:
  ref'as be `.json`, bet su `task=` → po `expirePreservedRefs` įrašas atsiranda ir tas pats bėgimas jį
  jau vertina (`done` + senas → `expired`), log'e `PRESERVED REF RECONCILED`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėja, kad reconcile prijungimas retencijoje
nepageidautinas (pvz. operatorius nusprendžia sutaikinimo mechanizmą trinti) — tada trinami
`preserved-ref-reconcile.ts` ir `infrastructure-preserved-ref-reconcile.test.ts`, o gamintojo `task=`
žyma lieka; trynimas be sprendimo NEDAROMAS.

## Neįtraukta
- Eksplicitinis `taskId` perdavimas per `rollback-stable.ts:363` portą (`restoreTaskScope(root, ref, paths)`)
  — CLI scope; su `current-task-id` fallback'u žyma atsiranda ir be jo.
- Task bucket'o paieška po `<id>-2.md` kolizijos (F13) — task 202.
- Retencijos dienų politika ir `git gc` — nekinta.
