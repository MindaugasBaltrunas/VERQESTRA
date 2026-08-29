# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 GeoGravity w1/w2 auditas — 17 iš 35 vaikų exit'ų be jokio stderr: pusė w2 gedimų nediagnozuojami (P0/P1)

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei kiekvienas `WAVE SLOT CHILD EXIT` su nenuliniu kodu VISADA palydimas
diagnostikos bloku (stderr uodega ARBA aiškus „stderr tuščias" + vaiko
paskutinės stdout eilutės + exit kontekstas) — ALREADY_IMPLEMENTED su
eilučių įrodymu.

## Tikslas
GeoGravity log auditas (2026-08-29): iš 35 `WAVE SLOT CHILD EXIT` tik 18
turi `--- child stderr (tail) ---` bloką. **17 (49 %) vaikų mirė be
jokios priežasties log'e** — nei stderr, nei stdout uodegos, nei exit
konteksto (pvz. 1179 atvejai 15:34:14 ir 18:52:41). Pusė w2 gedimų
nediagnozuojami iš principo — būtent todėl jų klasės nesimatė kodo
audite.

Taisymas žurnalavimo kelyje (`src/composition/loop/command.ts` — vaiko
proceso stderr/stdout surinkimas ir `WAVE SLOT CHILD EXIT` eilutės
autorius):

1. Nenulinis vaiko exit VISADA rašo diagnostikos bloką: stderr uodega
   (kaip dabar), o kai stderr tuščias — `--- child stderr: EMPTY ---` +
   paskutinės N stdout eilučių + `child exit context: code=<n>
   signal=<s> duration=<ms>`.
2. Vaiko stderr/stdout uodegos papildomai išsaugomos į
   `vq/logs/slots/<worker>-<task>-a<attempt>.log` (append) — kad
   diagnostika nepriklausytų nuo orchestrator.log rotacijos.
3. Tylus exit be jokio surinkto output'o — atskira, grep'inama eilutė
   `CHILD EXIT SILENT: <worker> <task>` (tokių atvejų stebėsena tampa
   įmanoma).

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/command.ts`
- `src/application/scheduling/slot-task-runner.ts` (TIK jei stderr
  surinkimas gyvena čia — tada jis vietoj command.ts dalies, įrašyti į
  ataskaitą)
- `src/tests/composition-loop-child-exit.test.ts` (numatomas naujas)

Draudžiama:
- `src/infrastructure/**`
- `src/interfaces/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Coder: diagnostikos blokas + slots log failas + SILENT eilutė.
- Tester: vaikas su stderr → kaip dabar; vaikas be stderr, su stdout →
  EMPTY žyma + stdout uodega; vaikas be nieko → SILENT eilutė; slots log
  failas pildomas append'u.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Gedimų PRIEŽASČIŲ taisymas (078/079). Log rotacijos politika (075).
UI atvaizdavimas (065 šeima jau dengia).
