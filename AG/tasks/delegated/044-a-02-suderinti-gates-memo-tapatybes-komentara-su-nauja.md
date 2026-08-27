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
openspec/changes/verqestra-backlog-v1

## Tikslas
`gates-memo.ts` tapatybės komentaras (11-19 eil.) nebemeluoja apie „viso medžio" semantiką: po `gates-memo-store` pataisos `tree` hash'as neapima `AG/tasks/**`, `AG/state/**`, `AG/logs/**`. Patvirtinti, kad esamas raudono / hit / corrupted elgesys nepakito.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/quality-gates/gates-memo.ts`
- `src/tests/quality-gates.test.ts`

Draudžiama:
- `src/infrastructure/process/gates-memo-store.ts`
- `src/application/quality-gates/quality-gates.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Perrašyk tapatybės komentarą 11-19 eil.: įvardyk, kad `tree` apima worktree be trijų lifecycle kelių, ir kad numatytoji kryptis lieka fail-closed (nauji keliai ĮEINA, kol nėra explicit išimties su pagrindimu).
- Įvardyk komentare, kodėl `AG/openspec/**` ir `AG/benchmark/**` liko hash'e.
- Patikrink `quality-gates.test.ts`, kad hit / miss / corrupted memo scenarijai lieka žali be testo silpninimo.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei komentaro tikslinimas atskleistų, kad realizuota semantika skiriasi nuo trijų sutartų kelių — tada tai kodo, ne komentaro klaida.

## Neįtraukta
- `gates-memo-store.identify` logika — uždaryta ankstesnėje užduotyje.
- Stop guard'o srautas ir vartų serializacija tarp stop guard'o ir dispatch'o.
