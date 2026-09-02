## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/quality-gates/preflight-rules.ts` turi vedančio YAML
frontmatter bloko (`---` … `---` failo pradžioje) atskyrimą, kurį naudoja IR
preambulės prilipdymas (`claude-preflight/index.ts` abu
`verificationPreamble(` kvietimai — 291 ir 478 eil.), IR
`stripVerificationPreamble`, o testas įrodo, kad task'as su frontmatter'iu po
`installReformulatedTask` → `moveTaskToBucket(queue)` grįžta baitas į baitą —
ALREADY_IMPLEMENTED: cituok helper'į ir testą.

## Tikslas
Įrodymas (GeoGravity 2026-09-01 21:30, task 1248): queue failas prasidėjo
YAML frontmatter'iu (`---\nschema_version: 2\nid: …\nscope:\n  allow: …\n---`,
po jo `# Task`). Preflight fastpath (`claude-preflight/index.ts:290-293`)
parašė `reformulated-task.md` = `verificationPreamble(...)` + tekstas, t. y.
preambulės `## Žingsnis 0 …` / `## Sandbox taisyklės` blokai atsidūrė PRIEŠ
frontmatter'į. `installReformulatedTask` (`coordinator-adapters.ts:139-145`)
tai įrašė į active failą. Kai infra abort'as (`run-coordinator-terminal.ts:298`)
grąžino failą į queue, `bucket-transition.ts:38-48` `stripDispatchPreambleBeforeExit`
iškvietė `stripVerificationPreamble` (`preflight-rules.ts:170-193`), kuri nuima
vedančią sekciją iki KITOS antraštės — o `---` eilutės antraštės nėra, tad
frontmatter'is nuėjo kartu su preambule. Po git diff'o queue faile liko tik
`# Task …`; GeoGravity `tools/scripts/ag-task-governance-audit.js:187-188`
tokį failą laiko pažeidimu (`schema_version must be 2`), o scope lock'ai
netenka `scope.allow` šaltinio.

Tas pats kelias laukia kiekvieno requeue/human-review perkėlimo iš
active/delegated lango (`moveTaskToBucket` yra vienintelis chokepoint'as —
092 invariantas), tad tai ne vienkartinis 1248 atvejis.

Sprendimo kryptis: frontmatter'is yra failo, ne task'o kūno dalis. Preambulė
prilipdoma PO vedančio frontmatter bloko (frontmatter → preambulė → `# Task`),
o `stripVerificationPreamble` vedantį frontmatter bloką praleidžia ir nuima
tik preambulės sekcijas po jo. Vienas grynas helper'is (pvz.
`splitLeadingFrontmatter(text): { frontmatter: string; body: string }`)
`preflight-rules.ts`, naudojamas abiejose pusėse — du parseriai išsiskirtų
tyliai.

Atmesta alternatyva: frontmatter'io atkūrimas iš git HEAD `stopRun` kelyje —
grąžinimas į queue turi būti deterministinis be git, o failas queue gali būti
dar necommit'intas (146 lenktynės).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/quality-gates/preflight-rules.ts` (frontmatter helper + stripVerificationPreamble praleidžia vedantį bloką)
- `src/interfaces/cli/dispatch/claude-preflight/index.ts` (abu verificationPreamble kvietimai lipdo po frontmatter)
- `src/tests/quality-gates-preflight.test.ts` (strip/prepend simetrija su frontmatter)
- `src/tests/interfaces-cli-preflight.test.ts` (fastpath reformulated su frontmatter: frontmatter pirmas, preambulė antra)
- `src/tests/task-execution-bucket-transition.test.ts` (round-trip: install → move į queue → tekstas identiškas originalui)

Draudžiama:
- `src/application/task-execution/bucket-transition.ts` (chokepoint'as teisingas — keičiasi tik strip semantika helper'yje)
- `src/application/task-execution/run-coordinator-terminal.ts` (stopRun kelias nekinta)
- `src/composition/loop/coordinator-adapters.ts` (installReformulatedTask nekinta)
- `src/interfaces/hooks/pre-hooks.ts` (validacijos lango taisyklė 213 eil. lieka)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `preflight-rules.ts`: helper'is, atpažįstantis vedantį frontmatter bloką
  TIK failo pradžioje (`---` pirmoje netuščioje eilutėje, uždaromas `---`
  savo eilutėje); viskas kita — kūnas. Be YAML parserio — tik ribos.
- `stripVerificationPreamble`: atskirti frontmatter'į, strip'inti kūną kaip
  dabar, sujungti atgal; be preambulės tekstas grąžinamas baitas į baitą
  (esamas `stripped ? … : original` kontraktas lieka).
- `claude-preflight/index.ts` 291-293 ir 478 eil.: preambulė lipdoma tarp
  frontmatter'io ir kūno; `stripVerificationPreamble(claudeTask)` prieš
  lipdymą tebevykdomas (046-a-02 sena preambulė).
- Testų lūkestis: (1) tekstas su frontmatter + preambule + `# Task` → strip
  palieka frontmatter + `# Task`; (2) tekstas be frontmatter — elgesys
  identiškas dabartiniam (regresijos sargas esamiems testams); (3) `---`
  vėliau tekste (pvz. markdown horizontali linija po `# Task`) NĖRA
  frontmatter'is; (4) round-trip per bucket-transition: queue tekstas su
  frontmatter'iu → install (preamble+tekstas) → move į queue → lygu
  pradiniam; (5) fastpath reformulated pradžia yra `---`, ne `## Žingsnis 0`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `worker-task-ir.ts`
(`DIRECTIVE_HEADING_PREFIXES`) arba `pre-hooks.ts:213` validacija remiasi tuo,
kad preambulė yra PIRMOJI failo eilutė — tada preambulės vietos keitimas kerta
jų kontraktą ir reikia atskiro sprendimo, ne tylaus plėtimo.

## Neįtraukta
- GeoGravity 1248 frontmatter'io atkūrimas — jau padarytas operatoriaus
  2026-09-02.
- Frontmatter'io TURINIO validacija (schema_version, scope.allow) — tai
  GeoGravity `ag-task-governance-audit.js` atsakomybė, VERQESTRA jį tik
  praneša.
- `scope.allow` naudojimas vietoj `## Failai` parserio scope lock'ams —
  atskiras architektūrinis sprendimas (žr. 150).
