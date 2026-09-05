# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/helpers/hooks-fake-fs.ts` egzistuoja ir šeši `interfaces-hooks-*.test.ts` failai
(`guards`, `protocol`, `pre-hooks`, `scope-guards`, `package-migration`, `log-rotation`) savo lokalų
`fakeFs` importuoja iš jo, o `interfaces-hooks-pre-hooks.test.ts` korpuso testas (425-461 eil.) nebeskaito
`path.join(repoRoot, "vq")` — ALREADY_IMPLEMENTED: cituok importus ir `runtimeRoot` eilutę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, T4 ir „Testai" P2;
`scratchpad/audit-tests.md` §2, §3, §4): šeši lokalūs `fakeFs` (`interfaces-hooks-guards.test.ts:41-53`,
`-protocol:46`, `-pre-hooks:36`, `-scope-guards:44`, `-package-migration:30`, `-log-rotation:15`) vs
`composition/hooks/guard-adapters.ts:31-37`/`pre-adapters.ts:121-128`: `exists: (p) => store.has(rel(p))`
— tik failai (realus `nodeFsAdapter.exists` → `true` ir katalogams); `makeDirectory: async () => {}`;
`writeTextFile` be tėvinio mkdir; klaidų klasės (EACCES/EISDIR) neegzistuoja; raktai santykiniai POSIX,
realus dirba absoliučiais (`D:\` vs `/repo` normalizacija paslėpta). Kodas, kuris `exists(dir)` naudoja
kaip „katalogas yra", fake'e visada gauna `false`. Antra: `interfaces-hooks-pre-hooks.test.ts:427-443`
korpuso vartas skaito REALŲ `vq/state/task-ledger.json` (`runtimeRoot = path.join(repoRoot, "vq")`) —
verdiktas `priklausomybe-unknown-id` priklauso nuo operatoriaus lokalaus runtime; `bucketFiles`
`catch { return [] }` be `length > 0` sargo — praeina vakuume.

## Agentai
readme-guard -> tester -> reviewer

## Failai
Leidžiama:
- `src/tests/helpers/hooks-fake-fs.ts` (numatomas naujas — bendras `HookFsPort` fake'as)
- `src/tests/interfaces-hooks-guards.test.ts`
- `src/tests/interfaces-hooks-protocol.test.ts`
- `src/tests/interfaces-hooks-pre-hooks.test.ts` (fakeFs 36-53 eil.; korpuso testas 425-461 eil.)
- `src/tests/interfaces-hooks-scope-guards.test.ts`
- `src/tests/interfaces-hooks-package-migration.test.ts`
- `src/tests/interfaces-hooks-log-rotation.test.ts`

Draudžiama:
- `src/interfaces/hooks/**` ir `src/composition/hooks/**` (produkcija nekinta; rasta klaida → ataskaita)
- `src/tests/interfaces-hooks-pre-hooks-known-ids.test.ts` (kita `fakeFs` forma su `listDirectoryIfExists` — neliečiama)
- `src/tests/helpers/post-hook-world.ts` (`fakePostHookWorld` — atskira šeima, žr. Neįtraukta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `helpers/hooks-fake-fs.ts`: vienas `fakeHookFs(files)` → `{ fs: HookFsPort; store; dirs }` su
  `nodeFsAdapter` semantika: `exists` → `true` failui IR katalogui (prefiksas `store`/`dirs`);
  `makeDirectory` registruoja katalogą (rekursyviai); `writeTextFile`/`appendTextFile` kuria tėvą kaip
  `mkdir -p`; `readTextFileIfExists` katalogui → meta `EISDIR` su `code`; raktai — absoliutūs
  normalizuoti keliai (`\` → `/`), ne `rel(p)`; neprivalomas `listDirectoryIfExists` grąžina failus IR
  katalogus.
- Šeši testų failai: lokalus `fakeFs` keičiamas importu; asercijos, kurios rėmėsi dreifu (`exists(dir)
  === false`), taisomos į realią semantiką — jei testas dėl to krenta, tai signalas apie produkciją,
  ne apie helper'į: užfiksuoti ataskaitoje, testą pažymėti `t.todo` su priežastimi.
- `pre-hooks` korpuso testas: `runtimeRoot` → `mkdtemp` (tuščias `state/`), `knownTaskIds` iš VISŲ
  bucket'ų katalogų (queue/active/delegated/human-review/done); `assert.ok(queueFiles.length > 0)` sargas
  (kaip `worker-prompt-compilation-preamble-size.test.ts:78`); `catch { return [] }` lieka tik
  neegzistuojančiam bucket'ui.
- Helper'io vienetinis testas — helper'io semantika pin'inama tame pačiame faile, kuriame ji pirmą kartą
  naudojama (`interfaces-hooks-protocol.test.ts`), ne atskiru failu.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Jei po `runtimeRoot` pakeitimo korpuso testas raudonas dėl
`priklausomybe-unknown-id` task'ui, kurio priklausomybė gyvena TIK ledger'yje — tai 2026-08-30 klasės
atvejis: bucket'ų sąjungą praplėsk `delegated`/`active`, ne grąžink realų `vq/`.

## Neįtraukta
- `helpers/post-hook-world.ts` (`exists` be katalogų, `fileMtimeMs: Date.now()`), `memory-scheduling-fs.ts`
  `listDirectoryIfExists` tik failai, `node-fs-port.ts` be containment — kitos fake'ų šeimos, atskiri task'ai.
- Composition hook'ų surišimo testai realiu fs — task 237.
- `quality-gates-preflight.test.ts:147` realus `vq/config` — task 240.
