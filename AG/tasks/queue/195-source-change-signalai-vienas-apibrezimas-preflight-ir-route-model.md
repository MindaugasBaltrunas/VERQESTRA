# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 183-broad-scope-vartas-naudoja-matchesallowedpath-semantika
- 186-retry-eskalacija-pasiekiama-su-sablono-biudzetu

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/token-governance/route-model.ts` `SOURCE_CHANGE_PATTERN` (144-145 eil.) ir
`src/application/quality-gates/preflight-rules.ts` „source change" šablonai (27-58 eil.) importuoja
VIENĄ apibrėžimą iš domain (pvz. `src/domain/project/source-change-signals.ts`), o profilio
`source_roots` veikia abiejose pusėse — ALREADY_IMPLEMENTED: cituok importus ir testą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, dublikatų sąrašas „„source change"
šablonai ×2"; `audit-application.md` TG-2). `route-model.ts:144-145`
`/\b(?:apps|modules|packages|workers|AG\/orchestrator)\/|\bmodule\.manifest\.ts\b|\bsrc\//i` ir
`preflight-rules.ts:27-58` turi skirtingus sąrašus: `lib/`, `cmd/`, `services/` ir profilio
`source_roots` tik preflight'e. Ta pati užduotis preflight'e laikoma source keitimu, o modelio
maršrutizatoriuje — `routine`, arba atvirkščiai; pakopa ir vartas nesutaria be jokio log'o.
Kryptis: domain funkcija `isSourceChangeText(text, sourceRoots)` (grynas, be IO) viename naujame
faile; abu vartotojai importuoja ją; `source_roots` paduodami iš profilio, kur jis pasiekiamas
(preflight jau turi; route-model gauna per `RouteModelInput` neprivalomą lauką — be jo naudojami
numatytieji šaknų sąrašai, tad kvietėjai svetimame scope nekinta).

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/project/source-change-signals.ts` (numatomas naujas; jei tinkamesnis `src/domain/project/profile.ts` — tas failas vietoje šio, įrašyti į ataskaitą)
- `src/tests/domain-project-source-change-signals.test.ts` (numatomas naujas)
- `src/application/token-governance/route-model.ts` (144-145, 169 eil.)
- `src/application/quality-gates/preflight-rules.ts` (27-58 eil.)
- `src/tests/token-governance-gates.test.ts`
- `src/tests/quality-gates-preflight.test.ts`

Draudžiama:
- `src/domain/project/index.ts` (eksportų fasadas — praplėsti tik jei kiti domain moduliai eksportuojami per jį; įrašyti į ataskaitą)
- `src/interfaces/**`
- `src/composition/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Naujas domain failas: sąjunga abiejų sąrašų (`apps/`, `modules/`, `packages/`, `workers/`, `lib/`,
  `cmd/`, `services/`, `src/`, `module.manifest.ts`, `AG/orchestrator/`) + `sourceRoots` parametras;
  žodžio ribos kaip dabar (`\b…\/`). Testai — kiekvienas sąrašo narys, `source_roots` papildymas,
  neigiami (`docs/`, `README.md`).
- `route-model.ts`: `SOURCE_CHANGE_PATTERN` → importas; `RouteModelInput.sourceRoots?: readonly string[]`.
- `preflight-rules.ts`: 27-58 eil. šablonai → tas pats importas; profilio `source_roots` kaip iki šiol.
- Regresija: `token-governance-gates.test.ts` ir `quality-gates-preflight.test.ts` esami atvejai
  žali; naujas atvejis — tekstas su `services/x.ts` route-model'yje duoda `source-change`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei sąjunga pakelia kurio nors
`token-governance-gates.test.ts` esamo atvejo pakopą iš `routine` į `standard` — tai realus
maršrutizavimo pokytis su kaina, operatorius sprendžia.

## Neįtraukta
- `HIGH_COMPLEXITY_PATTERN` (route-model 140-141) ir `task-classification.ts` keyword'ai — kiti
  apibrėžimai, kitos paskirties (task 179).
- `dead-export-gate` naujo eksporto registracija — eksportas turės du kvietėjus, vartas jį matys.
