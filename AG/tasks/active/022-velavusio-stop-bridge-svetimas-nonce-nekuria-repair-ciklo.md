# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/020-session-writes-ledger-diagnosis-2026-08-25.md (R2 giminingas radinys)

## Tikslas
Ištirti ir uždaryti `DISPATCH STOP BRIDGE FOREIGN` šaknį: vaiko stop-bridge įrašas su
nesutampančiu `dispatch_nonce` šiandien tik ignoruojamas, ir teisingai baigtas darbas virsta
repair ciklu (021-d-05 atvejis: darbas commit'intas `e9e7307`, bridge sakė `done`, bet nonce
svetimas → ignoruota → repair bandymas → „clean tree without work evidence" → human-review).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/state/stop-bridge.ts`
- `src/infrastructure/adapters/claude-dispatch-outcome.ts`
- `src/infrastructure/adapters/claude-dispatch-process.ts`
- `src/application/task-execution/stop-bridge-wait.ts`
- `src/tests/**`

Draudžiama:
- `src/application/scheduling/slot-task-runner.ts` (nonce valymo kontraktas — tik skaityti)
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- ĮRODYMAI: `vq/logs/orchestrator.log:3188` — `DISPATCH STOP BRIDGE FOREIGN:
  task=021-d-05-... status=done bet dispatch_nonce nesutampa — ignoruojama`. Iš viso 4 tokie
  įvykiai (2026-08-25: 08:04:55 task=010, 08:35:09 task=012, 10:10:53 task=007, 19:20:43
  task=021-d-05) — ir KIEKVIENAS jų koreliuoja su to paties task'o kritimu į
  human-review/error tą pačią dieną. Tai ne šalutinis triukšmas, o pasikartojantis mechanizmas
  po keliais šios dienos parkavimais. Kontekstas: 020 diagnozės įrodymas A rodo, kad vaiko
  Stop hook'as gali suveikti ~24 s PO `CLAUDE FINISHED` — orkestratorius kontrolę perima
  anksčiau, nei hook'ai baigia.
- IŠTIRTI hipotezę (patvirtinti arba paneigti ŽURNALU, ne prielaida): FOREIGN bridge yra
  ankstesnio TO PATIES task'o bandymo vėlavęs Stop hook'as — jis rašo bridge su savo (jau
  pasenusiu) nonce tada, kai orkestratorius jau laukia naujo bandymo nonce. Nonce gyvavimo
  grandinė: `claude-dispatch-process.ts:126-127` (in-process env mutacija su atstatymu),
  `slot-task-runner.ts:78` (vaikas nonce NEpaveldi aklai), `stop-bridge.ts:90-91` (be nonce
  bridge nerašomas), `claude-dispatch-outcome.ts:131-140` (`foreign-done` → ignoruojama).
- SPRENDIMO KRYPTYS (architect renkasi, pagrindžia; kryptis siaurinanti):
  1. bridge įrašą praturtinti task tapatybe taip, kad `foreign-done` skiltų į dvi klases:
     „svetimo TASK'O bridge" (ignoruoti kaip dabar) ir „SAVO task'o pasenusio bandymo bridge"
     — pastarasis ne ignoruojamas, o įskaitomas kaip vėlavęs to paties darbo įrodymas arba
     bent GARSIAI deklaruojamas verify priežastyje;
  2. rašymo pusėje: Stop hook'as, kurio nonce nebėra aktyvus (aktyvųjį rodo attempt
     namespace/veidrodis), savo bridge žymi `stale` vietoj `done` — vėlavęs įrašas nebegali
     apsimesti gyvu;
  3. abi kartu.
- Pasirinktą elgesį padengti regresiniu testu, atkuriančiu 021-d-05 seką: bandymo N commit'as
  + vėlavęs bridge su N nonce, orkestratorius laukia N+1 → darbas NEPRARANDAMAS į repair ciklą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok nedelsiant, jei sprendimas reikalautų keisti
`stopStateSchema` laukų prasmę senų įrašų skaitytojams — schema turi likti atgaliai suderinama.

## Neįtraukta
- R1/R2 darbai (uždaryti 020-a-02 ir 021 grandinėje).
- `slot-task-runner.ts` nonce valymo kontrakto keitimas.
- LLM kvietimai, queue loop vykdymas.
