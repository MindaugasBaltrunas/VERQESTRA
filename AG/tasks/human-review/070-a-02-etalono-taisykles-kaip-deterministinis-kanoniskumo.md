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
Išplėsti „task already canonical" patikrą `src/application/quality-gates/preflight-fastpath.ts` etalono taisyklėmis, kad neatitinkantis task'as gautų pažeidimo įrašą su konkrečios taisyklės citata, o ne tyliai praeitų į dispatch.

## Agentai
Privaloma grandinė, būtent šia tvarka: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/quality-gates/preflight-fastpath.ts`
- `src/tests/quality-gates-preflight.test.ts`
- `AG/tasks/examples/000-etalonas.md` (HUMAN-REVIEW-APPROVED: mindebaltru
  2026-08-29 — parkavimo priežastis buvo NE šio task'o rašymas: operatoriaus
  sesija redagavo etaloną lygiagrečiai su šiuo dispatch'u, o „dispatch
  identity unavailable" atribucija pakeitimą priskyrė task'ui; kelias
  legalizuojamas, kad perleidimas praeitų)

Draudžiama:
- `src/domain/tasks/sections.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-validate.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-llm.ts`
- `AG/tasks/examples/000-etalonas.md`
- `src/application/task-execution/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: nuspręsti, kur gyvena etalono taisyklių sąrašas (grynos funkcijos `preflight-fastpath.ts` viduje ar atskira konstanta), ir kokią struktūrą turi pažeidimo įrašas (taisyklės id + žmogui skaitoma citata).
- Coder: įgyvendinti taisykles — katalogų wildcard `**` be pagrindimo eilutės; produkcinis failas `## Failai` sąraše be atitinkamo testo failo; UI failai be `I18nContext` ir `dashboard.css`; `## Patikra` be nė vienos backtick komandos; `## Priklausomybės` su placeholder reikšmėmis. Funkcija grąžina pažeidimų sąrašą, verdikto ji nepriima.
- Tester: (a) wildcard be pagrindimo → pažeidimas su teisinga žinute; (b) UI task'as be I18nContext → pažeidimas; (c) etaloną atitinkantis task'as → nulis pažeidimų; (d) VISI esami `AG/tasks/queue/*.md` pro naują vartą praeina be pažeidimų.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei (d) punktas rodo, kad taisyklė parkuotų esamą queue task'ą — taisyklė tada švelninama arba task'as taisomas ATSKIRAI.

## Neįtraukta
Reformulate verdikto surišimas (vaikas 3), generatorių prompt'ai (vaikas 4), `sections.ts` keitimas, esamų queue task'ų perrašinėjimas.
