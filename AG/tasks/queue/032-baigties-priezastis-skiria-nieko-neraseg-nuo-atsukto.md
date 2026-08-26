# Task

## Spec source
openspec/changes/verqestra-backlog-v1
vq/logs/orchestrator.log (2026-08-26, 7 dispatch'ai be nė vieno rašymo įrankio)

## Tikslas
Atskirti dvi baigtis, kurios šiandien skelbiamos ta pačia eilute: „vykdytojas nieko
nerašė" ir „darbas atsuktas". Dabar abi virsta `clean tree without work evidence
(deliverable missing — possibly rolled back)`, ir operatorius siunčiamas ieškoti dingusio
darbo, kurio niekada nebuvo.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/verify-task.ts`
- `src/domain/diagnosis/dispositions.ts`
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/tests/**`

Draudžiama:
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI (2026-08-26 žurnalas): septyni task'ai baigėsi `clean tree without work evidence`,
  ir VISŲ jų `DISPATCH TOOL USAGE` rodo tik skaitymo įrankius — nė vieno `Write`/`Edit`:
  015-b-03, 018-b-03 (2 k.), 020-a-02, 022-b-03, 024-a-02, 024-b-03. Darbas neprarastas —
  jo nebuvo ką dirbti.
- Kaina konkreti: operatorius pagal šią eilutę ieško `preserved_work` nuorodos ir atkuria
  failus. 2026-08-26 tai suklaidino du kartus, o vienu atveju „išsaugotas darbas" pasirodė
  esąs visai kito task'o UI kodas.
- Telemetrija JAU egzistuoja: `infrastructure/adapters/claude-dispatch-finalize.ts:110`
  suskaičiuoja panaudotus įrankius. Trūksta tik to, kad signalas „ar vykdytojas apskritai
  rašė" pasiektų `resolveNoCommitDisposition` (`domain/diagnosis/dispositions.ts:224`),
  kurio įėjimai dabar yra tik markeris, dirty skaičius ir darbo įrodymas.
- Pridėti tą signalą kaip ĮĖJIMĄ, o ne naują šaką: dispozicija lieka `human-review`, nes be
  markerio tylus uždarymas draudžiamas (task 890 regresija). Keičiasi TIK priežasties
  eilutė — ji privalo pasakyti `executor made no write-tool calls`, kai rašymų nebuvo.
- Domeno funkcija lieka gryna: signalas ateina parametru, o ne skaitomas iš žurnalo.
- Testai: rašymų buvo + nėra commit'o → sena „possibly rolled back" priežastis; rašymų
  NEBUVO → nauja priežastis; abiem atvejais dispozicija ta pati `human-review`.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok nedelsiant, jei sprendimas imtų reikšti, kad
task'as be rašymų uždaromas kaip `done` — tai būtų 2026-08-14 false-done regresijos
atkūrimas, ir tokio sprendimo šis task'as neapima.

## Neįtraukta
- Skaidymo taisymas (atskiras task 033).
- `ALREADY_IMPLEMENTED` markerio semantikos keitimas.
- Automatinis tokių task'ų uždarymas.
