# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 — operatoriaus sprendimas variantas A: „matuoti hipotetinį SRC per pack lauką su CONTEXT_CACHE_VERSION kėlimu"

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Skaitytojo pusė. Ankstesnis task'as jau įdėjo į pack'ą optional hipotetinio SRC dydžio lauką (`code_context` bloke) ir pakėlė `CONTEXT_CACHE_VERSION` į 10. Dabar `persistContextPack` telemetrijos `symbol_source_chars` reikšmę turi imti iš to pack lauko, o ne iš `measureSymbolTierChars` (`src/application/context-pack/assemble/persist.ts:126`) virš jau demote'intų `symbol_fragments`.

Kritinis invariantas: persist.ts yra VIENINTELIS telemetrijos rašytojas, todėl cache HIT (`assemble.ts:171-191` eina tiesiai į `persistContextPack` su `lookup.entry.context_pack_json`) ir jį pagimdęs miss privalo emituoti IDENTIŠKUS `symbol_source_chars` / `symbol_signature_chars`. Laukas gaunamas iš pack'o, tad šakojimosi persist viduje neturi atsirasti.

Kai lauko nėra (senas arba SRC režimo pack'as) — fallback į esamą `measureSymbolTierChars` elgesį, nepakitusį.

Rezultatas: UI pora `fixedFieldPair("symbol_source_chars", "symbol_signature_chars")` nustoja būti amžinai „unmeasured" be jokių UI pakeitimų.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/persist.ts`
- `src/tests/context-pack-metrics.test.ts`
- `src/tests/characterization-context-pack-assembly.test.ts`
- `src/tests/fixtures/characterization/context-pack-assembly.json`

Draudžiama:
- `src/application/context-pack/context-pack-schema.ts`
- `src/application/context-pack/context-cache-model.ts`
- `src/application/context-pack/assemble/tiers.ts`
- `src/application/context-pack/metrics.ts`
- `src/interfaces/http/ui-compression-view.ts`
- `src/infrastructure/persistence/context-cache-store.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Coder: `persist.ts:126` — jei pack'o `code_context` turi hipotetinio SRC lauką, `symbol_source_chars` imti iš jo; kitu atveju palikti esamą `measureSymbolTierChars` rezultatą. `symbol_signature_chars` skaičiavimas nesikeičia.
- Tester: SIG režimo pack'e abu laukai > 0 ir hipotetinis SRC >= SIG; cache hit emituoja IDENTIŠKUS abu laukus kaip jį pagimdęs miss; SRC režimo ir „no code context" tvirtinimai (`context-pack-metrics.test.ts` ~283–396) lieka žali be silpninimo.
- Reviewer: patikrinti, kad persist.ts neįgijo hit/miss šakojimosi ir kad fallback kelias nekeičia senų pack'ų telemetrijos.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai `pnpm build` ir `pnpm test` žali. Sustok ir klausk, jei: pack lauko dar nėra (ankstesnis task'as neįvykdytas) — tada nieko nekeisk ir pranešk; jei reikėtų persist.ts šakoti pagal hit/miss; jei reikėtų pakartotinio source skaitymo persist metu (atmesta alternatyva); jei testą reikėtų susilpninti.

## Neįtraukta
- Pack schema, `CONTEXT_CACHE_VERSION` ir gather-time matavimas — ankstesnio task'o scope.
- `ui-compression-view.ts` ir jo testas — 087-a-02 scope.
