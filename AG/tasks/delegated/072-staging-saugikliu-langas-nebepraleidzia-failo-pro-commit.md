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

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 operatoriaus užsakytas w1/w2 auditas — GeoGravity w1/w2 veikia su klaidomis, tai viena iš šaknų (P0)

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 073-registraciju-valymas-visuose-worktree-salinimo-keliuose
- 074-neintegruoto-w2-darbo-apsauga-po-proceso-luzio
- 078-worktree-bootstrap-buildstamp-ir-pnpm-path-spragos
- 079-orphan-valymas-iveikia-untracked-failus-ir-fs-liekanas
- 080-vaiko-exit-visada-palieka-diagnoze-ir-stderr

## Žingsnis 0 — ar jau įgyvendinta?
Jei `session-stage-planning.ts` ledger-gap saugiklis veikia ir esant
galiojančiam savo baseline (t. y. `attemptStartKnown === true` jo nebeišjungia),
o allowed-paths fallback'as ima scope viduje esančius kelius net kai šalia
yra ir svetimų — ALREADY_IMPLEMENTED su eilučių įrodymu.

## Tikslas
Audito P0 radinys (2026-08-29): commit'as vyksta tik Stop hook'e, o staging
plano saugiklių grandinė turi langą, kuriame VISI trys saugikliai išsijungia
vienu metu ir failas tyliai iškrenta iš commit'o:

- clean-baseline rescue reikalauja švaraus baseline
  (`src/application/task-execution/session-stage-planning.ts:76-80`);
- ledger-gap saugiklį IŠJUNGIA galiojantis savo baseline
  (`session-stage-planning.ts:127-128`: `if (!nonce || attemptStartKnown)
  return [];`);
- allowed-paths fallback'as yra „viskas arba nieko"
  (`session-stage-planning.ts:180-182`: vienas kelias už scope — tuščias
  sąrašas).

Reali pasekmė 2026-08-28 10:18: task 055 baigė `done`, bet
`src/tests/ui-compression-view.test.ts` (kuris BUVO leidžiamų sąraše!) liko
neužcommit'intas → `LOOP STOP: dirty product tree`. GeoGravity diegime tas
pats mechanizmas gamina „dirty tree" stop'us.

Taisymas — susiaurinti langą, nesusilpninant svetimų rašymų apsaugos:
ledger'io praleidimo atveju keliai, kurie YRA task'o leidžiamoje aibėje,
privalo patekti į staging planą net su galiojančiu baseline; už scope
esantys — kaip iki šiol neliečiami ir raportuojami.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/session-stage-planning.ts`
- `src/tests/task-execution-session-stage-planning.test.ts` (numatomas; jei
  testas gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/interfaces/hooks/**` (Stop hook'o kvietėjas nesikeičia)
- `src/infrastructure/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: tiksli nauja saugiklių pirmumo tvarka, garantuojanti: (a)
  scope viduje esantis purvas VISADA patenka į planą; (b) svetimas/už scope
  purvas NIEKADA nepatenka; (c) elgesys deterministiškas be lenktynių.
- Tester: atvejis „galiojantis baseline + ledger praleido scope vidaus
  kelią" → kelias plane (dabar — ne); atvejis „mišrus purvas (savas + už
  scope)" → savas plane, svetimas ne; esami testai nesilpninami.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei taisymas reikalautų
keisti svetimų rašymų (foreign writes) semantiką.

## Neįtraukta
Stop hook TOCTOU (P2 — atskirai, jei operatorius norės). Log rotacijos
archyvas (075). Hook'ų prijungimo taškai.
