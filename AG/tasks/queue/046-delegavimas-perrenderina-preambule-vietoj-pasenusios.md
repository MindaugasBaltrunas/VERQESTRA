# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Worker prompt'o preambulė („## Žingsnis 0" + „## Sandbox taisyklės") yra RUNTIME
renderis, ne task'o turinys — kiekvienas delegavimas privalo ją perrenderinti šviežią.
Dabar requeue'intas task failas nešasi seną preambulę iš pirmojo preflight'o, o
fastpath jos neatnaujina: preambulės pataisos requeue'intų task'ų niekada nepasiekia.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/quality-gates/preflight-rules.ts`
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `src/tests/quality-gates-preflight.test.ts`
- `src/tests/interfaces-cli-preflight.test.ts`

Draudžiama:
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts` (042 uždarytas — neliesti)
- `src/application/task-planning/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI (2026-08-27): 041-a-02 antrasis dispatch'as (09:09) gavo prompt'ą su SENA
  „Sandbox taisyklės" versija — be 480a5b3 commit'e pridėtos taisyklės „Rašymo darbą
  atlik PATS šioje sesijoje". Priežastis: pirmojo preflight'o preambulė buvo įrašyta į
  patį task failą, requeue failą perkėlė su ja, o fastpath kelias preambulės
  neperrenderina. Kontrpriemonė, dėl kurios worker'is turėjo nebedeleguoti į fonines
  grandines, prompt'o tiesiog nepasiekė.
- INVARIANTAS: task failas bucket'uose yra TURINYS be preambulės; preambulė
  prijungiama tik delegavimo renderio metu, kiekvieną kartą šviežia. Sena preambulė
  įvestyje — ne klaida, o pašalintina liekana.
- SPRENDIMO KRYPTIS: grynas `stripVerificationPreamble(taskText)` šalia
  `verificationPreamble` (`preflight-rules.ts`) — nuima VEDANČIUS „## Žingsnis 0" ir
  „## Sandbox taisyklės" blokus iki pirmos kitos antraštės, fence-aware per
  `shared/markdown.findSectionBounds` prefikso predikatu (antraštės neša laisvus
  sufiksus — žr. worker-task-ir DIRECTIVE_HEADING_PREFIXES). NEliečia tų pačių
  antraščių, cituojamų task'o kūne po `# Task`.
- Taikymas abiejuose preambulės rašymo taškuose (`claude-preflight/index.ts:300` ir
  `:485`): pirma strip, tada šviežia preambulė. Fastpath ir LLM keliai elgiasi vienodai.
- Testai: (1) task'as su sena preambule delegavus gauna TIK naują (senos eilučių
  nebelieka, nauja viena); (2) task'as be preambulės — kaip iki šiol; (3) kūne
  fence bloke cituojama „## Sandbox taisyklės" antraštė išlieka nepaliesta;
  (4) grynos taisyklės ribos (`quality-gates-preflight.test.ts`): vedantis blokas
  nuimamas, ne-vedantis — ne.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei sprendimas imtų reikalauti keisti
worker-task-ir kompiliatorių arba task failų turinį bucket'uose migruojant atgaline
data — senos preambulės išsivalys natūraliai per kitą delegavimą.

## Neįtraukta
- Worker'io „deleguok ir baik turn'ą" elgesys — jį šis task'as tik vėl padengia
  kontrpriemone; jei ji nepakaks, kitas žingsnis būtų Agent įrankio draudimas
  dispatch'e (operatoriaus sprendimas, nes AGENT_ROUTING_TOOLS apsauga yra etalono 1:1).
- 041-a-02 turinys (foreign_decision_task_id priežastis) — padarytas atskirai
  2026-08-27.
