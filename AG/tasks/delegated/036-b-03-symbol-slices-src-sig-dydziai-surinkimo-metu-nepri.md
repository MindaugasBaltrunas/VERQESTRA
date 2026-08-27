## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „Surinkimo-meto SRC/SIG dydžių skaičiavimas“; design.md #7)
- `src/application/context-pack/assemble/persist.ts:94-117` — šiandien rašoma tik kai `symbolFragments.some(tier !== undefined)`

## Tikslas
`symbol_source_chars`/`symbol_signature_chars` pora skaičiuojama surinkimo metu ir rašoma VISADA, net kai pack'as renderinamas be tier'ų — kad operatorius galėtų sužinoti, ar verta jungti `symbol_slices`, jos nesujungęs.

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/persist.ts`
- `src/application/context-pack/assemble/gather.ts`
- `src/application/context-pack/assemble/tiers.ts`
- `src/tests/context-pack-metrics.test.ts`

Draudžiama:
- `AG/**`
- `vq/**`
- `.env`
- `src/interfaces/**`
- `ui-app/src/**`

## Veiksmas
- `architect` fiksuoja tikslų surinkimo tašką: SRC/SIG dydžiai skaičiuojami visada gather.ts/tiers.ts kelyje, prieš `symbol_slices` rodymo sprendimą, naudojant TIK jau turimus symbol fragmentus (be papildomo I/O, jei vėliava išjungta).
- `schedule-domain`/`coder` perkelia esamą persist.ts:115-127 sumavimo logiką į gather.ts/tiers.ts kelią; persist.ts skaito jau paruoštus dydžius vietoj perskaičiavimo po tier sprendimo.
- Renderinamas pack'o turinys ir `CONTEXT_CACHE_VERSION` nesikeičia, nebent matavimo perkėlimas pakeistų realų turinį — tada versiją pakelti.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok, jei matavimo perkėlimas reikalautų pakeisti realiai renderinamą pack'o turinį arba matuojamai sulėtintų surinkimą.

## Neįtraukta
- `bash_output_digest`, `dispatch_tool_schema`, `compact_dsl` rašytojai.
- `decideCompression` verdiktas ir `ui-app` vertimai.
- `symbol_slices` vėliavos įjungimas.
