# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/policies/scope-guard-rules.ts` `backendLineRules` `exec` taisyklė metodo kvietimo
`pattern.exec(line)` (receiveris ne `child_process`) NEblokuoja, o `interfaces-hooks-scope-guards.test.ts`
tą atvejį pin'ina — ALREADY_IMPLEMENTED: cituok taisyklės regex'ą ir testą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, D3, domain P1).
`scope-guard-rules.ts:24-25`: `/\bexec\s*\([^"']/.test(line)` — `\b` tarp `.` ir `e` YRA žodžio riba,
tad `pattern.exec(line)` (RegExp.prototype.exec) yra BLOCK `child_process.exec with variable input`.
Antra alternatyva `/exec\s*\([^)]*(req\.|request\.|body|params|query|\$\{)/` taip pat pagauna
`re.exec(req.body.x)`. Tai Stop hook'o blokas (`blocks: true`) bet kuriam `apps/api/**` failui su
regex'ų naudojimu. Šiame repo `.exec(` yra 83 kartus 43 produkciniuose failuose (pvz.
`preserved-ref-reconcile.ts:33` `TASK_ID_PATTERN.exec(message)`) — jie backend'u neklasifikuojami, bet
target projekte su `apps/api/src/**` kiekvienas toks failas neša BLOCK'ą. Etalono 1:1, bet klaidingas.
Kryptis: taisyklė šauna tik shell vykdymo kontekste — receiveris `child_process`/`cp`/`childProcess`,
plikas `exec(`/`execSync(`/`execFile(` be `.` prieš (`(?<![\w$.])`), arba `require("child_process")`/
`from "child_process"` toje pačioje eilutėje; `.exec(` su kitu receiveriu niekada.

## Agentai
readme-guard -> architect -> security -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/domain/policies/scope-guard-rules.ts` (`backendLineRules` exec taisyklė)
- `src/tests/domain-scope-guard-rules.test.ts` (numatomas naujas; testai rašomi TIK čia — `interfaces-hooks-scope-guards.test.ts` priklauso task 238, jo esami `:62-71` atvejai lieka žali)

Draudžiama:
- `src/tests/interfaces-hooks-scope-guards.test.ts` (task 238)
- `src/domain/policies/line-rules.ts` (variklis nekinta)
- `src/domain/policies/file-classification.ts` (task 205)
- `src/interfaces/hooks/scope-guards.ts` (adapteris nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Korpuso patikra (task 157 pamoka): Grep `\.exec\(` per `src/**` ir `ui-app/**` — įrašyti skaičių į
  ataskaitą; `vq/project/profile.json` `backendRoot` patikrinti, ar kuris nors iš tų failų šiame repo
  klasifikuojamas backend'u (`isBackendApiFile`); jei taip — tai gyvas blokas, kurį šis task'as uždaro,
  ir tie failai lieka NEliečiami (taisoma taisyklė, ne korpusas).
- `scope-guard-rules.ts`: BLOCK, kai (a) `(?:^|[^\w$.])exec(?:Sync|File|FileSync)?\s*\(` su ne-literaliu
  pirmu argumentu (`[^"'\`]` ar `\`` su `${`) ARBA (b) `\b(?:child_process|childProcess|cp)\.exec(?:Sync|File)?\s*\(`
  ARBA (c) eilutė mini `child_process` ir turi `exec(`; user-input alternatyva (`req.`, `body`, `params`,
  `query`, `${`) taikoma TIK (a)/(b) formoms. `x.exec(...)`, `re.exec(req.body.x)`, `pattern.exec(line)` —
  jokio radinio. Žinutė lieka `uses child_process.exec with variable/user-influenced input`.
- Testai (`domain-scope-guard-rules.test.ts`, per `scanLineRules` kaip `interfaces-hooks-scope-guards.test.ts:63`):
  `pattern.exec(line)` ir `re.exec(req.body.dir)` → be radinių; esamas `interfaces-hooks-scope-guards.test.ts:67`
  `exec(\`ls ${req.body.dir}\`)` toliau BLOCK (tas failas nekeičiamas, lieka žalias); `child_process.exec(cmd)` → BLOCK; `cp.execSync(userCmd)` → BLOCK;
  `execSync("ls -la")` (literalas) → be bloko; `const { exec } = require("child_process"); exec(cmd)` → BLOCK.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei korpuso patikra parodo, kad šio repo failai
klasifikuojami backend'u ir NAUJOJI forma vis dar juos blokuoja — tada taisyklės forma persvarstoma,
korpusas neperrašomas.

## Neįtraukta
- Kitos `backendLineRules` heuristikos (`console.log`, `throw`, `cors()`) — WARN, nekeičiamos.
- Frontend/mobile taisyklės — be radinių audite.
- `line-rules.ts` variklio semantika (`blocked ||=`) — patikrinta švari.
