# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/` turi testą, importuojantį `../composition/hooks/pre-adapters.js`, `guard-adapters.js`,
`session-adapters.js` ir `adapters.js` (grep `composition/hooks/` per `src/tests/**` — 2026-09-05: 0) —
ALREADY_IMPLEMENTED: cituok failus ir importus.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, T4; `scratchpad/audit-tests.md`
§5a composition): `hooks/pre-adapters.ts#preHookPorts`, `guard-adapters.ts#secretScanPorts|packageGuardPorts|
migrationGuardPorts|postWriteGuardPorts|scopeGuardPorts`, `session-adapters.ts#sessionHookPorts|
sessionSummaryPorts|userPromptDeps`, `adapters.ts#postHookPorts` — VISAS PreToolUse/PostToolUse/Session
hook'ų surišimas be jokio testo: 0 importuojančių testų, nė vienas vardas neminimas. Stop/pre-write vartai,
kuriais pasitiki ciklas, produkcijoje eina per portus, kurių niekas neinstancijavo; hooks testų `fakeFs`
(×125) dreifuoja nuo `nodeFsAdapter` (`exists` be katalogų, `makeDirectory` no-op, niekada nemeta) — tad
gryna logika žalia, o realus surišimas nepatikrintas. Šis task'as — tik NAUJI testai realiems adapteriams
per `mkdtemp`; fake'ų suvienodinimas — task 238.

## Agentai
readme-guard -> tester -> reviewer

## Failai
Leidžiama:
- `src/tests/composition-hooks-pre-guard-adapters.test.ts` (numatomas naujas: `preHookPorts` + 5 guard portai)
- `src/tests/composition-hooks-session-post-adapters.test.ts` (numatomas naujas: `sessionHookPorts`, `sessionSummaryPorts`, `userPromptDeps`, `postHookPorts`)

Draudžiama:
- `src/composition/hooks/**` (testai dengia esamą elgesį; rasta klaida → ataskaita ir atskiras task'as)
- `src/interfaces/hooks/**`
- `src/infrastructure/fs/node-fs-adapter.ts`
- `src/tests/interfaces-hooks-*.test.ts` (task 238)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Kiekvienam portų fabrikui: sukonstruoti su `mkdtemp` `runtimeRoot`/`projectRoot`, patikrinti, kad
  grąžinamas objektas turi VISUS porto tipo laukus (kompiliacija) ir kad `fs` metodai elgiasi kaip
  `nodeFsAdapter`: `exists(dir)` → `true`, `makeDirectory` kuria rekursyviai, `readTextFileIfExists`
  trūkstamam → `undefined`, `writeTextFile` į neegzistuojantį katalogą — tas pats elgesys kaip realus
  (mkdir -p arba klaida — užfiksuoti faktą, ne norą).
- `preHookPorts`: `listDirectoryIfExists` (jei portas jį deklaruoja) grąžina failus IR katalogus;
  `collectKnownTaskIds` kelias su realiu bucket'u tmp kopijoje.
- Guard portai: `secretScanPorts`/`packageGuardPorts`/`migrationGuardPorts`/`postWriteGuardPorts`/
  `scopeGuardPorts` — vienas end-to-end atvejis kiekvienam per realų hook'ą (pvz. `.env` rašymas
  blokuojamas su realiu fs), ne per fake'ą.
- `sessionHookPorts`/`sessionSummaryPorts`/`userPromptDeps`/`postHookPorts`: sesijos failo rašymas ir
  skaitymas per realų fs; `gitStatusForPath`/`readStdin` — tik forma (be realaus git/stdin), su `t.skip`
  ir priežastimi, jei aplinka neleidžia.
- Klaidų klasės: `EACCES`/`EISDIR` atvejis (skaityti katalogą kaip failą) — užfiksuoti, ką realus portas
  daro (meta ar `undefined`), kad task 238 fake'as atkartotų tą patį.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Jei testas atskleidžia produkcinę klaidą surišime (portas grąžina ne
tai, ko tikisi hook'as) — testą rašyk taip, kad jis KRISTŲ, pažymėk `t.todo`/`skip` su priežastimi ir
įrašyk radinį į ataskaitą; produkcijos čia netaisyk (draudžiama).

## Neįtraukta
- `stop-adapters.ts#stopHookPorts` — audito sąraše nebuvo; jei laiko lieka, ta pati forma antrame faile.
- Hooks testų `fakeFs` suvienodinimas su `nodeFsAdapter` — task 238.
- `composition/loop`, `composition/quality`, `composition/runtime` adapteriai — task 239.
