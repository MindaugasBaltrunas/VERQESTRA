# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Preflight'o LLM reformulacija ir task skaidymas negali įrašyti `## Failai` kelių, kurių
projekte nėra. Išsigalvotas kelias paverčia scope guard'ą loterija: worker'is redaguoja
TIKRUS failus, diagnostika juos paskelbia „outside allowed paths", seka rollback ir
human-review — nors darbas taiklus ir žalias.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/quality-gates/preflight-rules.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-llm.ts`
- `src/application/task-execution/task-splitting.ts`
- `src/tests/quality-gates-preflight.test.ts`
- `src/tests/task-execution-rules.test.ts`

Draudžiama:
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts` (042 ką tik uždarytas — neliesti)
- `src/interfaces/hooks/**` (scope guard'ai teisingi; taisoma AUTORIAVIMO pusė)
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI (2026-08-27 09:02, task 032-b-03): reformulacija deklaravo
  `ui-app/src/panels/CompressionPanel.tsx` ir `ui-app/src/i18n/lt.ts` — nė vieno iš šių
  kelių repo'je NĖRA (tikri: `ui-app/src/view/pages/CompressionPage.tsx`,
  `ui-app/src/i18n/I18nContext.tsx`). Worker'is redagavo tikruosius, diagnostika parkavo
  „changed files outside allowed paths" + `rollback_failed=1`; darbas buvo geras ir
  praėjo tik po rankinės peržiūros. Ta pati klasė anksčiau: 042 vaikai paveldėjo
  reformulacijos tekstą, o repair perrašinėjo task failą.
- INVARIANTAS: konkretus `## Failai / Leidžiama` kelias, kurio TĖVINIS KATALOGAS
  neegzistuoja, yra autoriavimo klaida — jokio legalaus scenarijaus jam nėra (naujas
  failas teisėtai deklaruojamas tik egzistuojančiame kataloge; katalogo kūrimą apimantis
  task'as naudoja glob'ą, ne pramanytą konkretų kelią). Egzistuojančio katalogo +
  nesamo failo pora LIEKA leidžiama — tai normalus „naujas testų failas" atvejis.
- SPRENDIMO KRYPTIS: gryna taisyklė `preflight-rules.ts` (kelių ištraukimas iš
  `## Failai` jau yra šiame faile — žr. backtick bullet parser'į) + patikra dviejuose
  autoriavimo taškuose: (1) po LLM reformulacijos (`preflight-llm.ts` kelias) — radus
  neegzistuojantį tėvinį katalogą, reformuluoto task'o `## Failai` PAKEIČIAMAS
  ORIGINALAUS task'o sekcija (žmogaus autoritetas > modelio perrašymas) su garsia
  `CLAUDE PREFLIGHT: ... hallucinated-allowed-path` log eilute; (2) skaidymo vaikams
  (`task-splitting.ts`) — ta pati patikra prieš rašant vaiko failą.
- Architektui spręsti: FS prieigos forma (per esamus preflight/splitting portus — jokio
  naujo tiesioginio IO application sluoksnyje) ir ar glob'ai (`**`) tikrinami iki pirmo
  meta simbolio, ar praleidžiami — bet fail-open kryptis: ABEJOTINAS kelias paliekamas,
  keičiama tik ĮRODYTA klaida (tėvinio katalogo nėra).
- Testai: (1) reformulacija su nesamo katalogo keliu -> `## Failai` grįžta į originalą,
  log eilutė yra; (2) egzistuojantis katalogas + nesamas failas -> paliekama kaip yra;
  (3) glob'ai nekeičiami; (4) vaiko task'as su pramanytu keliu neparašomas be pataisos.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei sprendimas imtų reikalauti keisti scope
guard'ų ar rollback pusę (`interfaces/hooks`), arba jei originalo `## Failai` perėmimas
imtų reikšti wildcard'o įrašymą ten, kur originalas turėjo konkrečius kelius.

## Neįtraukta
- Scope guard'o / rollback elgesys — jie veikė teisingai pagal tai, kas deklaruota.
- 032-b-03 retrospektyva — darbas jau peržiūrėtas ir priimtas rankomis.
- Repair fazės teisė perrašinėti task failą — atskira liga, atskiras kandidatas.
