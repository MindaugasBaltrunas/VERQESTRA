# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 185-pack-biudzetas-skaito-konfigo-klasifikacija-ir-human-review-balsa
- 186-retry-eskalacija-pasiekiama-su-sablono-biudzetu

## Žingsnis 0 — ar jau įgyvendinta?
Tikrinti po punktą: (1) `src/application/context-pack/assemble/assemble.ts:319` `max_llm_calls`
imamas iš `tool-budget.json` (`loadContextPackToolFlags`/`tool-budget-config`), ne literalas `3`;
(2) `src/application/token-governance/tool-budget-gates.ts:149` „context chars" matuoja TĄ PATĮ
užkoduotą pack'ą (`JSON.stringify(pack, null, 2)`), kurį matuoja `persist.ts`; (3) `assemble.ts:341-382`
overflow kopėčios veikia ir kai `symbol_slices` išjungtas, o `symbolFragments` su `signature` vis
tiek yra; (4) `specCharBudget` (180 eil.) nebemažinamas task teksto ilgiu. Visi — ALREADY_IMPLEMENTED
su citatomis; kitaip daromi likę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Application; `audit-application.md`
CP-2, CP-3, CP-4).
- CP-2 „max_context_chars" lyginamas su trimis dydžiais: assemble/persist — pretty JSON pack'as
  (`JSON.stringify(pack, null, 2)`, `assemble.ts:332`); `tool-budget-gates.ts:149` — kompaktiškas
  `JSON.stringify(contextPack)`; preflight — task teksto ilgis (tvarko task 183). Enforcement mato
  mažesnį skaičių nei assemble, tad vartas „context chars" praleidžia pack'ą, kurį assemble laikė
  per dideliu. Plius `specCharBudget = max - taskText.length` (`assemble.ts:180`) — spec biudžetas
  mažinamas task teksto ilgiu, nors task tekstas į pack'ą nepatenka. Kryptis: `persist.ts`
  eksportuoja `encodeContextPack(pack)` (vienintelis kodavimas) ir `measureContextPackChars`;
  `assemble.ts` lokalus `encode` ir `tool-budget-gates.ts` matavimas naudoja jį.
- CP-3 `assemble.ts:319` `max_llm_calls: 3` hardcoded — `tool-budget.json` `default.max_llm_calls`
  nekeičia pack'o (kontrakto drift'as; renderis lauko nerodo). Kryptis: imti iš tos pačios
  `tool-budget.json` konfigūracijos, kurią `loadContextPackToolFlags` jau skaito.
- CP-4 PLAUSIBLE `assemble.ts:341-382` overflow kopėčios tik kai `symbolSlicesEnabled`; su flag'u OFF
  `symbolFragments` su `signature` (iki 8×~200 simb.) vis tiek yra nedroppinamas overhead; `small`
  tier 6000 → perrinkimo ciklas išmeta visus droppable, o `persist.ts:199` meta „context pack exceeds
  max_context_chars" → human-review. Pradėti nuo testo (`small` tier, flag OFF, 8 simboliai su
  signature): jei praeina — punktas ALREADY_IMPLEMENTED; jei meta — kopėčios taikomos
  nepriklausomai nuo flag'o (flag'as valdo SRC/SIG praturtinimą, ne apsaugą nuo perpildymo).
Pack'o turinys keičiasi (CP-3 laukas, CP-4 kopėčios, CP-2 spec biudžetas) → keliamas
`CONTEXT_CACHE_VERSION`.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/assemble.ts` (180, 319, 332, 341-382 eil.)
- `src/application/context-pack/assemble/persist.ts` (`encodeContextPack`/`measureContextPackChars` eksportas; 199 eil. matavimas)
- `src/application/token-governance/tool-budget-gates.ts` (149 eil. „context chars" per bendrą matavimą)
- `src/application/context-pack/context-cache-model.ts` (`CONTEXT_CACHE_VERSION` +1 po 185)
- `src/tests/context-pack-assemble.test.ts`
- `src/tests/token-governance-gates.test.ts`
- `src/tests/context-pack-code-index-identity.test.ts` (pin'as)
- `src/tests/context-pack-guards.test.ts` (pin'as)

Draudžiama:
- `src/application/quality-gates/preflight.ts` (preflight „context chars" — task 183)
- `src/application/context-pack/metrics.ts` (CP-5 — task 194)
- `src/application/policy-governance/tool-budget-config.ts` (loader'is importuojamas, nekinta)
- `src/interfaces/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `persist.ts`: `export function encodeContextPack(pack): string` (pretty JSON + `\n`, kaip
  `assemble.ts:332`) ir `measureContextPackChars(pack)`; 199 eil. ir assemble naudoja jį.
  `tool-budget-gates.ts:149` — tas pats matavimas (importas `../context-pack/assemble/persist.js`;
  patikrinti, kad `persist.ts` neimportuoja `token-governance` — ciklo nėra).
- `assemble.ts:319`: `max_llm_calls` iš tool-budget konfigo (`toolFlags` praplėsti arba antras
  laukas iš to paties loader'io); 180 eil. `specCharBudget` = `max_context_chars` minus fiksuotas
  rezervas be task teksto (doc'e paaiškinti, kodėl task tekstas nesiskaičiuoja).
- CP-4 testas → pagal rezultatą kopėčių sąlyga 361-366 eil. be `symbolSlicesEnabled`.
- Pakelti `CONTEXT_CACHE_VERSION` ir pin'us (`context-pack-code-index-identity.test.ts`,
  `context-pack-guards.test.ts`); paminėjimas čia yra etalono 9 taisyklės reikalavimas.
- Testai: `token-governance-gates.test.ts:259` „context chars" priežastis išlieka su tuo pačiu
  prefiksu, bet skaičius sutampa su `measureContextPackChars`; `context-pack-assemble.test.ts` —
  `budget.max_llm_calls` seka konfigą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `context-pack-metrics.test.ts` ar
`characterization-compact-dsl.test.ts` (importuoja `persistContextPack`, ne šio scope) raudonuoja
dėl matavimo pokyčio — tada charakterizacijos atnaujinimas yra operatoriaus sprendimas.

## Neįtraukta
- `metrics.ts` `readContextSizeMetrics` atsparumas sugadintai eilutei (CP-5) — task 194.
- Preflight „context chars" (task teksto ilgis) — task 183.
- `context-compression.json` vėliavų įjungimas (visos `false`, canary 0 %) — konfigo/šablono
  sprendimas, ne šio task'o.
