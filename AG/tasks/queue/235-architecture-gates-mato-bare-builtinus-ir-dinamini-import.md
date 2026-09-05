# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/architecture-gates.test.ts` specifikatorių rinkimas apima `import("…")` literalus ir
`import "…"` side-effect formas, o builtin'ų politika (`:138-143`) atpažįsta ir `from "fs"`/`"path"`
be `node:` prefikso — ALREADY_IMPLEMENTED: cituok regex'us ir vienetinį testą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, T2; `scratchpad/audit-tests.md` §4):
`architecture-gates.test.ts:70` `IMPORT_SPECIFIER` mato tik `import|export … from`, `:138` builtin'ų
politika tik `specifier.startsWith("node:")`. Apėjimai: `import { readFileSync } from "fs"` domain'e —
vartas žalias; `await import("../../infrastructure/…")` interfaces'e į sluoksnių ir ciklų grafą nepatenka;
`import "./x.js"` — taip pat. `src/tests/helpers/dead-export-gate-scan.ts:17` turi `DYNAMIC_IMPORT` regex'ą
— klasė žinoma, bet ne čia. KORPUSAS (Grep `\bimport\(` ir `from "(fs|path|…)"` per `src/**`, 2026-09-05):
bare builtin'ų ir side-effect importų — 0; dinaminiai literalai: `composition/loop/coordinator-adapters.ts:289`
→ `infrastructure/git/git-client.js` (composition → infrastructure — LEIDŽIAMA), type-level
`application/context-pack/ports.ts:34-40` → `./context-cache-model.js`/`./context-cache-key.js` (tas pats
sluoksnis; nė vienas iš jų neimportuoja `ports.js` — ciklo nėra), `ts-loader.ts:10` `import("typescript")`
(paketas — ignoruojamas), `runtime/integration-adapters.ts:89` (ne literalas — nematomas). Naujas vartas
korpuso NENUDAŽO — todėl `## Failai` produkcinių failų nėra (task 157 pamoka patikrinta, ne prielaidauta).

## Agentai
readme-guard -> tester -> reviewer

## Failai
Leidžiama:
- `src/tests/architecture-gates.test.ts`

Draudžiama:
- `src/composition/loop/coordinator-adapters.ts` (dinaminis importas leistinas — nekeičiamas)
- `src/application/context-pack/ports.ts`
- `src/tests/helpers/dead-export-gate-scan.ts` (savo regex'ą turi; bendrinimas — ne šio task'o)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Specifikatorių rinkimas: prie `IMPORT_SPECIFIER` pridėti `import\s*\(\s*["']…["']\s*\)` (įskaitant
  type-level `import("./x.js").T`) ir `^\s*import\s+["']…["']` side-effect formą; visos trys eina ir į
  sluoksnių, ir į ciklų grafą.
- Builtin'ų politika: `node:`-prefiksas IR bare vardai iš `node:module` `builtinModules` sąrašo
  (`fs`, `fs/promises`, `path`, `crypto`, `os`, `http`, `net`, `child_process`, …) normalizuojami į
  `node:<vardas>` prieš tikrinant `ALLOWED_NODE_BUILTINS`; domain'e bare `fs` — pažeidimas.
- Vienetiniai testai specifikatorių ištraukėjui: statinis, re-eksportas, dinaminis (vienoje ir keliose
  eilutėse), side-effect, type-level `import("…")`, ne-literalas (`import(url)`) — praleidžiamas.
- Vartų testai lieka su „bazė nulis" asercijomis; korpuso įrodymas iš Tikslo užrašomas testo antraštėje.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei naujas vartas vis dėlto nudažo produkcinį failą,
kurio šis task'as neleidžia keisti — tai reiškia, kad Tikslo korpuso patikra praleido atvejį; failas
ir jo testas tada pridedami ATSKIRU task'u, ne slapta praplečiant ribas.

## Neįtraukta
- `Buffer` globalas domain'e (`canary.ts:37`, `changes.ts:59`) — auditas P2, atskira taisyklė su korpusu.
- `node-verification-rules.ts:72` `findForbiddenDistImports` ta pati `^import … from` skylė — kita sritis.
- `dead-export-gate-scan.ts` ir šio varto regex'ų bendrinimas — refaktoringas.
