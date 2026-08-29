# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 — operatoriaus sprendimas variantas A (087-a-02 human-review klausimas): „matuoti hipotetinį SRC per pack lauką su CONTEXT_CACHE_VERSION kėlimu"

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/context-pack/context-pack-schema.ts` jau aprašo hipotetinio
SRC dydžio lauką pack'e (grep pagal naują lauką `code_context` bloke, pvz.
`hypothetical`/`source_chars`), `src/application/context-pack/assemble/persist.ts`
`symbol_source_chars` reikšmę ima iš to pack lauko (ne vien iš
`measureSymbolTierChars` virš jau demote'intų `symbol_fragments`), o
`CONTEXT_CACHE_VERSION` faile
`src/application/context-pack/context-cache-model.ts` yra >= 10 —
ALREADY_IMPLEMENTED: nurodyk lauko pavadinimą, persist.ts eilutę ir versijos
reikšmę kaip įrodymą.

## Tikslas
`symbol_slices` shadow pora UI amžinai „unmeasured": SIG režimu
`symbol_source_chars` visada 0, nes rašytojo pusės task'as 087 (done) matuoja
`measureSymbolTierChars` (`src/application/context-pack/assemble/tiers.ts:127`)
virš JAU demote'intų pack'o `symbol_fragments` — SIG simbolis ten nešasi tik
`signature`, jo source tekstas sąmoningai numestas `applyCodeContextTiers`.
Riba dokumentuota tiers.ts ~109–126 komentare: hipotetinis SRC dydis SIG
simboliui išmatuojamas TIK gather metu (kai `candidates.sourceSlices` tekstas
rankose, be papildomo I/O), bet `persist.ts` yra VIENINTELIS telemetrijos
rašytojas — cache HIT ir jį pagimdęs miss privalo emituoti identiškus įrašus,
o hit gather'io nebėga (`assemble.ts:171-191` hit kelias eina tiesiai į
`persistContextPack` su `lookup.entry.context_pack_json`).

Operatoriaus sprendimas 2026-08-29 (variantas A): matavimą pernešti per PACK'Ą —
naujas laukas pack'e, kad hit'as jį grąžintų iš cache (`context_pack_json`
jau yra cache įrašo turinys, tad atskiro cache entry lauko nereikia), o
persist rašytų vienodai abiem keliais. Tai keičia pack'o turinį → PRIVALOMA
pakelti `CONTEXT_CACHE_VERSION`
(`src/application/context-pack/context-cache-model.ts:100`, dabar 9):
nepakėlus, senas įrašas be naujo lauko grįžtų kaip hit ir tyliai anuliuotų
pataisą (CLAUDE.md pack'o semantikos taisyklė). Atmesta alternatyva —
pakartotinis source skaitymas persist metu: telemetrija mokėtų būtent tą I/O,
kurio kompresija vengia (tiers.ts komentaro argumentas).

Rezultatas: SIG režimu veikiančio pack'o telemetrijoje `symbol_source_chars`
neša HIPOTETINĮ SRC dydį (kiek kainuotų tie patys simboliai SRC tier'e), o
`symbol_signature_chars` — realų SIG dydį; abu identiški tarp cache hit ir
miss to paties pack'o. Tada UI pora (`ui-compression-view.ts:265`
`fixedFieldPair("symbol_source_chars", "symbol_signature_chars")`) pradės
matuotis be jokių UI pakeitimų.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/tiers.ts`
- `src/application/context-pack/assemble/gather.ts`
- `src/application/context-pack/assemble/assemble.ts`
- `src/application/context-pack/assemble/persist.ts`
- `src/application/context-pack/context-pack-schema.ts`
- `src/application/context-pack/context-cache-model.ts` (CONTEXT_CACHE_VERSION 9 → 10)
- `src/tests/context-pack-metrics.test.ts` (persist telemetrijos tvirtinimai — čia gyvena esami symbol_source_chars testai)
- `src/tests/context-pack-assemble.test.ts` (integracinis assemble kelias)
- `src/tests/context-pack-guards.test.ts` (priminimo testas su literal versija — eilutė 194 lūš keliant, atnaujinti žinutę)
- `src/tests/context-pack-code-index-identity.test.ts` (eilutė 54 tvirtina `CONTEXT_CACHE_VERSION === 9` — atnaujinti kartu)
- `src/tests/characterization-context-pack-assembly.test.ts` (hit/miss identiškumo tvirtinimai; liesti tik jei projekcija pasikeičia)
- `src/tests/fixtures/characterization/context-pack-assembly.json` (tik jei naujas pack laukas keičia užfiksuotas projekcijas)

Draudžiama:
- `src/interfaces/http/ui-compression-view.ts` (087-a-02 scope, dabar human-review)
- `src/tests/ui-compression-view.test.ts` (087-a-02 scope)
- `src/application/context-pack/metrics.ts` (laukų lentelė — `symbol_source_chars`/`symbol_signature_chars` jau egzistuoja, eil. 119 ir 140)
- `src/infrastructure/persistence/context-cache-store.ts` (entry forma nesikeičia — laukas keliauja pack'o `context_pack_json` viduje)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: parinkti pack lauko formą — kur `code_context` bloke
  (`context-pack-schema.ts`, `contextPackCodeContextSchema` apie eil. 72)
  gyvena hipotetinis SRC dydis (agregatas ar per-simbolį), laikantis
  vieno-rašytojo invarianto: laukas užpildomas miss kelyje surinkimo metu,
  persist.ts jį tik SKAITO, tad hit (kuris pack'ą gauna iš cache) ir miss
  emituoja identiškus įrašus be jokio šakojimosi persist viduje. Laukas
  optional — seni/SRC režimo pack'ai jo neturi ir elgesys nesikeičia.
- Coder: matavimas gather metu — `applyCodeContextTiers`
  (`src/application/context-pack/assemble/tiers.ts:22`) turi
  `candidates.sourceSlices` rankose; ten (ar iškart po kvietimo
  `assemble.ts:348`) suskaičiuoti, kiek SIG tier'ui priskirti simboliai
  kainuotų SRC tier'e, ir įrašyti į pack'ą prieš encode. `persist.ts:126`
  telemetrijos reikšmę imti iš pack lauko, kai jis yra (fallback į esamą
  `measureSymbolTierChars` elgesį, kai lauko nėra). Pakelti
  `CONTEXT_CACHE_VERSION` į 10 (`context-cache-model.ts:100`) ir atnaujinti
  abu literal priminimo testus bei tiers.ts ~109–126 komentarą (riba
  nebegalioja — sprendimas priimtas ir įgyvendintas).
- Tester: (a) SIG režimo pack'as — telemetrijoje abu laukai > 0 ir
  hipotetinis SRC >= SIG; (b) cache hit emituoja IDENTIŠKUS
  `symbol_source_chars`/`symbol_signature_chars` kaip jį pagimdęs miss;
  (c) SRC režimo elgesys nepakitęs (esami `context-pack-metrics.test.ts`
  tvirtinimai lieka žali be silpninimo); (d) senas cache įrašas (version 9)
  po kėlimo — miss, ne hit.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei pasirodytų, kad hit/miss
identiškumo neįmanoma išlaikyti be cache entry formos keitimo
(`context-cache-store.ts` yra draudžiamas — tai reikštų kitą sprendimo
variantą nei operatoriaus patvirtintas A).

## Neįtraukta
UI poros keitimas (`ui-compression-view.ts` FEATURE_PAIR_SELECTORS) — 087-a-02
scope, dabar human-review; po šio task'o operatorius jį requeue. Tier
parinkimo/demote logika (`applyCodeContextTiers` sprendimai nesikeičia — tik
matavimas šalia). `worker_prompt_chars` — 086 (done), jau veikia. Cache entry
formos ar `context-cache-store.ts` keitimas — nereikalingas, laukas keliauja
pack'o viduje.
