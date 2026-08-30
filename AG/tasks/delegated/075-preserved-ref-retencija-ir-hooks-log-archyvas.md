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
`src/interfaces/hooks/log-rotation.ts:36` trumpindamas `hooks.log` perrašo failą vietoje ir negrįžtamai naikina nukerpamas eilutes (2026-08-28 „dirty tree" incidento įrodymai prarasti). Prieš trumpinimą nukerpama dalis privalo būti pridedama (append) į VIENĄ archyvo failą `hooks.log.1`, kuris pats trumpinamas ties dydžio riba — jokių begalinių archyvų grandinių.

Pirmiausia atlik Žingsnis 0: jei rotacija jau archyvuoja nukerpamą dalį, sustok ir raportuok ALREADY_IMPLEMENTED su eilučių įrodymu.

## Agentai
Privaloma grandinė (ta pati eilės tvarka, be praleidimų):
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/hooks/log-rotation.ts`
- `src/interfaces/hooks/session-start.ts`
- `src/tests/interfaces-hooks-protocol.test.ts`
- `src/tests/interfaces-hooks-log-rotation.test.ts`

Draudžiama:
- `src/infrastructure/git/rollback-scope.ts`
- `src/composition/loop/command.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `rotateFileByLines` prieš `writeTextFile` nukerpamas eilutes prideda į archyvo failą (numatytasis vardas — `<filePath>.1`) per esamą `HookFsPort`; archyvas trumpinamas ties riba, kad neaugtų be galo.
- Prijunk pakeitimą prie kvietėjo `src/interfaces/hooks/session-start.ts` nekeisdamas jo elgesio, kai failo nėra arba jis trumpesnis už `maxLines`.
- Testai: nukirpta dalis atsiranda archyve; antra rotacija prideda, o ne perrašo; peraugęs archyvas trumpinamas ties riba; nesamas/tuščias failas archyvo negamina.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei archyvavimas reikalautų naujo porto metodo `HookFsPort` kontrakte.

## Neįtraukta
Preserved ref retencija (atskira užduotis). Kitų `vq/logs` failų rotacijos politika. `git gc` orkestravimas.
