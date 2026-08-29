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
openspec/changes/verqestra-backlog-v1/

## Tikslas
Rašytojo pusėje nuspręsti ir, jei įmanoma be papildomo I/O, įgyvendinti, kad tas pats pack'as SIG režimu gautų ABU dydžius (`symbol_source_chars > 0` IR `symbol_signature_chars > 0`) į `context-size.jsonl`. Šiandien `measureSymbolTierChars` (`src/application/context-pack/assemble/tiers.ts:109-123`) sumuoja ARBA SRC, ARBA SIG pagal faktinį tier, tad SRC visuose įrašuose lieka 0 ir shadow pora niekada nesulyginama.

Prieš pradedant: jei `measureSymbolTierChars` jau grąžina abu dydžius tam pačiam pack'ui — ALREADY_IMPLEMENTED, cituoti eilutes ir sustoti.

## Agentai
PRIVALOMA grandinė (be praleidimų, readme-guard pirmas):
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/tiers.ts`
- `src/application/context-pack/assemble/persist.ts`
- `src/tests/context-pack-assemble.test.ts`

Draudžiama:
- `src/interfaces/http/ui-compression-view.ts`
- `src/application/context-pack/metrics.ts`
- `src/application/context-pack/context-cache-key.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: nustatyti, ar hipotetinį SRC dydį SIG režimu galima išmatuoti be papildomo source failų skaitymo (`tiers.ts:101-108` „no extra I/O" fallback'as; `persist.ts:126` kviečia ant jau demotintų `symbol_fragments`); verdiktą su pagrindimu įrašyti į ataskaitą.
- Coder: jei be papildomo I/O įmanoma — matuoti abu dydžius tam pačiam pack'ui; tier PARINKIMO logika ir pack'o turinys (fragmentai, tier sprendimai) nekeičiami, keičiasi tik telemetrija.
- Tester: `src/tests/context-pack-assemble.test.ts` tvirtina, kad SIG režimo pack'as duoda abu dydžius, SRC režimo elgesys nepakitęs, o pack'o turinys identiškas prieš ir po keitimo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. SUSTOK ir klausk, jei abiejų dydžių matavimas reikalautų papildomo source failų skaitymo (telemetrija neturi pabranginti kelio, kurį kompresija pigina) arba jei sprendimas paliestų pack'o turinį — tada `CONTEXT_CACHE_VERSION` klausimas keliamas operatoriui, ne bump'inamas tyliai. Sustojus aiškiai parašyk, kad darbą perima UI pusės child task'as.

## Neįtraukta
UI selektoriaus `FEATURE_PAIR_SELECTORS.symbol_slices` poros keitimas (`ui-compression-view.ts:265`) — atskiras nuoseklus child task'as. `CONTEXT_CACHE_VERSION` kėlimas — sąmoningai ne. `worker_prompt_chars` rašytojas — task 086. Kešo hit/miss telemetrijos semantika nekeičiama.
