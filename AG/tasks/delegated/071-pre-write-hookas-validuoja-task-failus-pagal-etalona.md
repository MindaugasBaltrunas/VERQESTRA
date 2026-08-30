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
Sukurti gryną etalono struktūros validatorių `validateTaskAgainstEtalonas(text, knownTaskIds): Violation[]` `domain/tasks` sluoksnyje. Tai bendra šerdis, kurią vėliau importuos ir pre-write hook'as, ir 070 preflight vartas — ne kopija. Šiame darbe TIK taisyklės ir jų testai; jokio hook'o prijungimo.

## Agentai
Privaloma grandinė, būtent šia tvarka: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/domain/tasks/etalonas-rules.ts`
- `src/tests/domain-tasks-etalonas-rules.test.ts`

Draudžiama:
- `src/domain/tasks/sections.ts`
- `src/interfaces/hooks/pre-hooks.ts`
- `src/application/quality-gates/preflight-rules.ts`
- `AG/tasks/examples/000-etalonas.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: apibrėžti `Violation` formą (taisyklės id, pažeista sekcija, žinutė, kuri VISADA cituoja `AG/tasks/examples/000-etalonas.md`) ir funkcijos parašą. `domain` sluoksnyje JOKIŲ `node:` importų — todėl egzistuojančių task id sąrašas ateina kaip funkcijos argumentas, ne kaip FS skaitymas; sekcijos skaitomos per esamą `src/domain/tasks/sections.ts` (tik importas, failas nekeičiamas).
- Coder: keturios taisyklės — (1) privalomos sekcijos etalono tvarka; (2) `## Failai` katalogo wildcard be pagrindimo eilutės šalia; (3) `## Priklausomybės` placeholder (`none`/`-`/`TBD`) arba nuoroda į id, kurio nėra `knownTaskIds`; (4) `## Patikra` komanda ne iš leistinų formų — žinutėje išvardyti leistinas.
- Tester: kiekvienai taisyklei po blokavimo ir po praėjimo atvejį; teigiamas kontrolinis atvejis — `AG/tasks/examples/000-etalonas.md` turinys grąžina tuščią `Violation[]`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei taisyklė reikalautų `node:` importo `domain` sluoksnyje arba `sections.ts` parserio keitimo.

## Neįtraukta
Hook'o prijungimas `pre-hooks.ts` (kitas darbas eilėje). 070 preflight varto surišimas. Etalono turinio keitimas. Turinio kokybės vertinimas — tikrinama tik struktūra, prasmę vertina preflight LLM.
