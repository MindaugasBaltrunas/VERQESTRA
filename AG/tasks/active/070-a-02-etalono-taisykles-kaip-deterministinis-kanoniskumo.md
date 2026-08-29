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
