# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 operatoriaus užsakytas w1/w2 auditas — repo augimo ir įrodymų praradimo higiena (P1)

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `refs/verqestra/preserved/*` turi retencijos mechanizmą (TTL/limitas su
trynimo kodu) ir `hooks.log` rotacija prieš trumpinimą archyvuoja senąją
dalį — ALREADY_IMPLEMENTED su eilučių įrodymu.

## Tikslas
Du audito P1 higienos radiniai (2026-08-29):

1. **Preserved ref'ai be retencijos.** `rollback-scope.ts:107-110` rašo
   `refs/verqestra/preserved/<commit>`, trynėjo NĖRA nė vieno (grep per
   visą src — nulis `update-ref -d`). Diske jau 7 ref'ai per 3 paras
   (`.git/packed-refs`), kiekvienas laiko pilną medį nuo GC; šalia
   `vq/state/rollback-preserved/*.json` irgi be valymo. Dizaino dokumentas
   (`docs/audits/021-rollback-preserve-design-2026-08-25.md:335`) spragą
   pripažįsta.
2. **hooks.log rotacija naikina įrodymus.**
   `src/interfaces/hooks/log-rotation.ts:36` perrašo failą vietoje be
   archyvinės kopijos — 2026-08-28 10:18 „dirty tree" incidento
   paaiškinančios eilutės prarastos negrįžtamai.

Taisymas:
- Retencija: preserved ref'as trinamas, kai (a) jo task'as yra `done` IR
  (b) ref'as senesnis nei N parų (numatytoji N=14, konfigūruojama), IR
  (c) `.json` įraše nėra `recovered=false` žymos iš preserved-work review.
  Trynimas — per esamą orphan/priežiūros ciklą, su log eilute
  `PRESERVED REF EXPIRED: <ref> task=<id> age=<d>`. Atitinkamas `.json`
  archyvuojamas/trinamas kartu.
- Rotacija: prieš trumpinant `hooks.log`, nukerpamą dalį pridėti (append)
  į `hooks.log.1` (vienas archyvo failas, pats rotuojamas dydžiu) — jokių
  begalinių archyvų grandinių.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/rollback-scope.ts`
- `src/infrastructure/git/preserved-ref-retention.ts` (numatomas naujas)
- `src/interfaces/hooks/log-rotation.ts`
- `src/composition/loop/command.ts` (TIK retencijos žingsnio prijungimas
  prie esamo priežiūros ciklo)
- `src/tests/infrastructure-git-preserved-work.test.ts`
- `src/tests/infrastructure-preserved-ref-retention.test.ts` (numatomas)
- `src/tests/interfaces-hooks-log-rotation.test.ts` (numatomas; jei testas
  gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- Ref'ų trynimas `rollback` metu (retencija — atskiras priežiūros kelias)
- `git gc` / `reflog expire` kvietimai (tik ref'o pašalinimas — GC lieka
  git'ui)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: retencijos vartų tikslus kontraktas (kada ref'as TIKRAI
  nebereikalingas) ir prijungimo taškas; suderinti su 074 eskalacijos
  sargu, kad neintegruoto darbo ref'as niekada nebūtų „pasenęs".
- Tester: ref'as su done task'u ir amžiumi > N → trinamas su log eilute;
  jaunas / ne-done / recovered=false → paliekamas; rotacija → nukirpta
  dalis atsiranda archyve, o archyvas pats trumpinamas ties riba.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei retencijos vartai
reikalautų trinti ref'ą, kurio task'o būsenos nustatyti neįmanoma.

## Neįtraukta
Kitų vq/logs failų rotacijos politika. `git gc` orkestravimas. Eskalacijos
sargas (074).
