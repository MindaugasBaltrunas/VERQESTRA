# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/ (slot-2 auditas 2026-08-26, radinys 3, antra pusė) — antra dalis iš dviejų

## Tikslas
`wildcard-scope` įrodymo spraga nebeuždedama ribotam glob'ui (`src/tests/a-*.test.ts` — vienas katalogas, fiksuotas plėtinys). Spraga lieka tik neribotos apimties šablonams (`src/tests/**`, `**/x.ts`).

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/scheduling/conflict-detector.ts`
- `src/tests/scheduling-conflict-detector.test.ts`

Draudžiama:
- `src/domain/scheduling/scope-lock-rules.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Abiejose `wildcard-scope` spragos vietose (`conflict-detector.ts:182` ir `:199`) spraga dabar uždedama BET KOKIAM šablonui; atskirk ribotą apimtį (be `**` segmento, vienas katalogas, fiksuotas plėtinys) nuo neribotos ir spragą palik tik neribotai.
- Nekeisk `src/domain/scheduling/scope-lock-rules.ts` — sankirtos taisyklė jau uždaryta ankstesne užduotimi; ši dalis liečia tik įrodymo spragos klasifikavimą.
- Testai `src/tests/scheduling-conflict-detector.test.ts`: ribotas glob'as → be `wildcard-scope` spragos ir pora `independent`; `src/tests/**` → spraga lieka; `**/x.ts` → spraga lieka.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok nedelsiant, jei ribotumo kriterijus negali būti apibrėžtas taip, kad neribotas šablonas praslystų kaip ribotas — klaidinga `independent` pora reiškia du vykdytojus tame pačiame faile.

## Neįtraukta
- Glob/glob sankirtos taisyklė domain sluoksnyje (ankstesnė užduotis).
- Užduočių `## Failai` konvencija (task 034).
- `worktree-policy.json` įjungimas ir worker prašymo numatytosios reikšmės.
