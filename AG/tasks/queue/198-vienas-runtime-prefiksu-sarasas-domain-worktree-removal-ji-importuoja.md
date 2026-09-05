# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/infrastructure/git/worktrees/worktree-removal.ts` neturi savo `RUNTIME_JUNK_PREFIXES`
masyvo, o `isRuntimeJunkPath` remiasi `src/domain/git/changes.ts` eksportu (`isRuntimePath` ir
build-artefaktų taisykle) — ALREADY_IMPLEMENTED: cituok importą ir `isRuntimeJunkPath` kūną.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, I3; infrastructure F3). Du
„runtime prefiksų" sąrašai: `worktree-removal.ts:32-41` `RUNTIME_JUNK_PREFIXES` (`vq/`, `AG/state/`,
`AG/logs/`, `logs/`, `dist/`, `node_modules` be `/`, `.pnpm-store/`, `storage/`) ir
`domain/git/changes.ts:22-32` `runtimePrefixes` (`vq/{supervisor,logs,state,project,runtime}/`,
`AG/openspec/`, `AG/tasks/<bucket>/`, `logs/`, `dist/`). `worktree-reaper.ts:253-254` komentaras
teigia, kad tai VIENAS sąrašas — netiesa. Pasekmės: `removeTaskWorktree` (`runtimeJunkForce: true`,
:203-206) `--force` šalina kopiją, kurios vienintelis nešvarumas yra `storage/**` — taikinio projekte
(Laravel) tai PRODUKTO kelias, kurį „RESIDUE" doktrina (:126-129) žada palikti žmogui, o
`reapTreeState` tą patį kelią laiko `dirty`; `node_modules` be `/` sutampa ir su `node_modules_backup/`.
Kryptis: vienintelis runtime sąrašas lieka domain'e (`isRuntimePath`), o build/deps artefaktai
(`node_modules/`, `.pnpm-store/`) — atskira gryna domain taisyklė `isBuildArtifactPath`;
`worktree-removal.ts` importuoja abi. `storage/` iš junk sąrašo DINGSTA (produkto kelias).
`AG/state/`, `AG/logs/`: VERQESTRA stop bridge rašo į `vq/state` (`stop-bridge.ts`), grep
`src/**` be testų šių kelių rašytojo nerodo (tik `gates-memo-store.ts:44` LIFECYCLE_PATHS sąrašas ir
komentarai) — jie į domain sąrašą NEDEDAMI, nebent Veiksmo grep'as ras realų rašytoją.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/git/changes.ts` (`isBuildArtifactPath`, `runtimePrefixes` lieka vienintelis)
- `src/infrastructure/git/worktrees/worktree-removal.ts` (`RUNTIME_JUNK_PREFIXES` trinamas, `isRuntimeJunkPath` per domain)
- `src/infrastructure/git/worktrees/worktree-reaper.ts` (tik 253-254 komentaras)
- `src/tests/git-rules.test.ts`
- `src/tests/infrastructure-worktrees.test.ts`
- `src/tests/infrastructure-worktrees-merge-contention.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts` (task 202)
- `src/infrastructure/process/gates-memo-store.ts` (savas LIFECYCLE_PATHS sąrašas — kita semantika)
- `src/tests/domain-git-changes.test.ts` (nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `changes.ts`: `export function isBuildArtifactPath(filePath)` — `node_modules/` (su `/`, plius tikslus
  `node_modules`) ir `.pnpm-store/`; `node_modules_backup/x` → `false`. `runtimePrefixes` lieka privatus,
  `isRuntimePath` — vienintelė runtime tiesa. Grep `AG/state/|AG/logs/` per `src/**` be testų: rašytojo
  nėra → į sąrašą nededama; jei yra — dedama į `runtimePrefixes` su komentaru, kas rašo.
- `worktree-removal.ts`: `isRuntimeJunkPath(entry) = isRuntimePath(entry) || isBuildArtifactPath(entry)`
  po tos pačios kabučių/separatorių normalizacijos; `RUNTIME_JUNK_PREFIXES` ir jo komentaras (:24-41)
  išnyksta, `runtimeJunkForce` dokumentacija (:113-118) rodo į domain funkcijas.
- `worktree-reaper.ts:253-254`: komentaras sako tiesą — vienas sąrašas domain `isRuntimePath`.
- Testai: `git-rules.test.ts` — `isBuildArtifactPath` ribos (`node_modules/x`, `node_modules`,
  `.pnpm-store/x` → true; `node_modules_backup/x`, `storage/x` → false); `infrastructure-worktrees.test.ts` —
  kopija, nešvari VIEN `storage/app/x` → `removeTaskWorktree` NEforce'ina (`infrastructure` su git
  atsisakymo tekstu), kopija nešvari `vq/logs/x` + `node_modules/y` → `removed` su `fallback: "runtime-junk"`;
  Grep esamų testų, pin'inančių `storage/` kaip junk — jie perrašomi į naują tiesą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei grep'as parodo realų `AG/state/`/`AG/logs/`
rašytoją (stop bridge senoji forma) — tada tie prefiksai keliauja į domain `runtimePrefixes`, o ne
dingsta tyliai.

## Neįtraukta
- `gates-memo-store.ts` LIFECYCLE_PATHS (`AG/tasks`, `AG/state`, `AG/logs`) — kešo tapatybės sąrašas,
  kita semantika, nesuvienodinamas.
- Orphan reaper'io force kelias su archyvu — nekinta (jis `runtimeJunkForce` nenaudoja).
- Bucket'o paieška po kolizijos (F13) — task 202.
