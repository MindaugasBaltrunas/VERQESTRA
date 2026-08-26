# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md (skyrius „R3")

## Tikslas
`verify-task` rašymo aktyvumą privalo skaityti iš SAVO bandymo žurnalo. Dabar adapteris ignoruoja
`taskId` ir paduoda globalų `vq/logs/claude-last.log`, todėl task 032 pastatytas tikslesnės
priežasties kelias praktikoje neįsijungia: operatorius siunčiamas ieškoti darbo, kurio nebuvo.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/coordinator-adapters.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `src/domain/diagnosis/dispositions.ts` (taisyklė teisinga, keičiamas tik jos įvadas)
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI (2026-08-26): trys dispatch'ai — `035` (`orchestrator.log:6094`), `038` (`:6353`) ir
  `031` (`:6515`) — baigėsi eilute `TASK NOT DONE: … clean tree without work evidence (deliverable
  missing — possibly rolled back)`. Ta priežastis MELAGINGA: nė vienas jų dalyvis nenaudojo rašymo
  įrankio (`DISPATCH TOOL USAGE … main=Agent,ScheduleWakeup agent=Glob,Grep,Read`), tad atsukti
  nebuvo ko — `ROLLBACK TASK-SCOPED: restored 0 task path(s)` visais trim atvejais.
- Teisinga eilutė egzistuoja: `resolveNoCommitReviewReason` (`domain/diagnosis/dispositions.ts:256`)
  grąžina `executor made no write-tool calls`, kai `writeActivity === "no-writes"`. Ji buvo gyva —
  `032-b-03` uždarytas 14:29Z, o visi trys gedimai įvyko vėliau. Vadinasi į ją atkeliavo
  `"unknown"`, nors tos pačios sesijos pjūvis buvo `parsed=true events=23`.
- ĮTARIAMASIS (patvirtinti pirma, prieš taisant): portas deklaruoja
  `readClaudeLog(taskId: string)` (`application/task-execution/run-coordinator-ports.ts:160`), o
  adapteris `coordinator-adapters.ts:326` yra `readClaudeLog: () => readOptionalFile(…/claude-last.log)`
  — argumentas ignoruojamas ir skaitomas GLOBALUS paskutinės bet kurios sesijos žurnalas.
  `classifyDispatchWriteOutcome` iš netinkamo žurnalo teisingai grąžina `"unknown"`.
- SPRENDIMO KRYPTIS: adapteris skaito attempt-first ir tik po to krenta į globalų veidrodį —
  lygiai taip, kaip tai jau daro `composition/ui/dashboard-adapters.ts:160-163`. To skaitytojo
  logika NEDUBLIUOJAMA: arba iškeliama į bendrą vietą, arba pakartotinai panaudojama esama.
  Fallback'as privalo palikti garsią žurnalo eilutę, kad tylus nuosmukis į legacy nebūtų nematomas.
- RIBA: `"unknown"` semantika nekeičiama. Tyli ar neatpažinta sesija niekada nevirsta teiginiu
  „rašymų nebuvo" — keičiasi tik tai, KURĮ žurnalą klasifikatorius mato.
- Testai (`task-execution-run.test.ts`, šalia esamų eilutėse 249 ir 284): (1) attempt žurnalas be
  rašymo įrankių → priežastis `executor made no write-tool calls`; (2) attempt žurnalo nėra, o
  globalus priklauso KITAM task'ui → `"unknown"`, priežastis lieka esama; (3) attempt žurnalas su
  `Edit` → `"wrote"`, elgesys nepakitęs.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei paaiškėtų, kad attempt žurnalo šiame taške apskritai
dar nėra — tada tai ne adapterio, o dispatch'o rašymo tvarkos klausimas, ir sprendimas kitoks.

## Neįtraukta
- Vartas „dispatch'as negali baigtis be rašymo įrankio" — tai politikos sprendimas, ne šio
  task'o dalis. Čia tvarkoma tik priežasties tiesa.
- `resolveNoCommitDisposition` sprendimų (done/rollback/human-review) keitimas.
- 032 pastatytos taisyklės perrašymas.
