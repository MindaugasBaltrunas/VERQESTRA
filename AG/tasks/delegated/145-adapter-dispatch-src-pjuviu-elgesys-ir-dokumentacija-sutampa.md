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
Jei `src/infrastructure/adapters/adapter-dispatch.ts` komentaras prie
`staleSourceSlices: "unchecked"` (dabar 95-103 eil.) nebežada „vartas
konteksto neprisega → kelias degraduoja", o sako refuse ARBA
`buildAdapterExecutionRequest` opcijos turi realų `staleSourceSlices`
perdavimo kelią, IR testas pin'ina pasirinktą elgesį (Grep
`cannot verify them against the working tree` src/tests kataloge randa
adapterio kelio atvejį) — ALREADY_IMPLEMENTED: cituok komentarą ir testą.

## Tikslas
RAG auditas 7 (2026-09-01), P2: `adapter-dispatch.ts:95-103` komentaras
teigia, kad su `staleSourceSlices: "unchecked"` „šis kelias degraduoja tik
tada, kai realiai turi ką prarasti" — t. y. žada SKIP be konteksto. Reali
grandinė kitokia: `src/application/task-execution/execution-context-gate.ts`
`validateExecutionContext` 168-170 eil. `"unchecked"` + pack'as su SRC
pjūviais grąžina failure, o 221-222 eil. kiekvienam source-change
ne-repair dispatch'ui failure virsta REFUSE — `claudeAdapterDispatch`
(117-127 eil.) tada iš viso nedispatch'ina (`execution_context_refused`).
Įjungus `symbol_slices` canary adapterio kelias taptų nedarbingas, o
komentaras skaitytoją įtikintų priešingai. Fail-closed kryptis TEISINGA —
sprendimas ne silpninti vartą, o suderinti elgesį ir dokumentaciją
SĄMONINGU pasirinkimu: arba adapterio kelias gauna realų slice-freshness
kelią (kvietėjas su IO paduoda `staleSourceSlices`, kaip CLI kelias
`claude-dispatch/command.ts:104+` daro per
`context-pack/source-slice-freshness`), arba komentaras perrašomas į
tiesą apie refuse — abiem atvejais su testu, kuris pasirinktą elgesį
pin'ina. Papildomai (P3): `execution-context-gate.ts:75-78`
`resolveExecutionContextMode` nežinomą ne tuščią
`AG_EXECUTION_CONTEXT_MODE` reikšmę (pvz. rašybos klaidą `requried`)
tyliai paverčia `preferred` — saugumo režimo env su klaida nusileidžia į
švelnesnį režimą be jokio signalo.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/adapters/adapter-dispatch.ts`
- `src/application/task-execution/execution-context-gate.ts`
- `src/tests/infrastructure-dispatch-flow.test.ts` (adapterio kelio
  atvejai — `buildAdapterExecutionRequest`/`claudeAdapterDispatch` testai
  gyvena čia, 53-108 eil.)
- `src/tests/interfaces-cli-dispatch-plan.test.ts`
  (`resolveExecutionContextMode` pin'ai 132-134 eil. ir gate atvejai)

Draudžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/command.ts` (CLI kelias
  freshness JAU skaičiuoja — jis etalonas, ne taikinys; iš to seka:
  `resolveExecutionContextMode` SIGNATŪRA nekeičiama, kitaip šis failas
  būtų paliestas už scope)
- `src/application/context-pack/source-slice-freshness.ts` (skaičiavimo
  modulis teisingas — tik naudojamas)
- `src/composition/**` (naujo wiring šis task'as nekuria — žr. Stop)
- `dist/**`
- `node_modules/**`

## Veiksmas
- ŽINGSNIS 1 (architect, PRIEŠ kodavimą): verdiktas su pagrindimu
  ataskaitoje — (A) realus freshness kelias ar (B) dokumentuotas refuse.
  Faktas sprendimui: `claudeAdapterDispatch` produkcinių kvietėjų src'e
  šiandien NĖRA (Grep 2026-09-01: tik `infrastructure-dispatch-flow.test.ts`),
  tad (A) šakoje nėra kam freshness paduoti be naujo wiring.
- (A) ŠAKA: `ClaudeAdapterDispatchOptions` gauna neprivalomą
  `staleSourceSlices: readonly string[] | "unchecked"` (default
  `"unchecked"` — fail-closed elgesys nesikeičia niekam, kas jo nepaduoda);
  `buildAdapterExecutionRequest` jį perduoda vartui; komentaras 95-103 eil.
  perrašomas: be kvietėjo paduoto šviežumo kelias yra REFUSE, ne
  degradacija.
- (B) ŠAKA: keičiasi TIK komentaras 95-103 eil. (ir, jei reikia,
  `claudeAdapterDispatch` refuse šakos 118-119 eil. komentaras) — tiesa
  apie refuse ir nuoroda, kad pilnam kontekstui šviežumą skaičiuoja
  kvietėjas su disku, kaip CLI kelias.
- ABIEM šakom testas `infrastructure-dispatch-flow.test.ts`: pack'as su
  SRC snapshot'u per adapterio kelią be šviežumo duomenų → refuse su
  `cannot verify them against the working tree` priežastimi (pin'as, kad
  dokumentacija nebegalėtų išsiskirti su elgesiu tyliai); (A) šakoje
  papildomai — paduotas `staleSourceSlices: []` → attach.
- P3: `resolveExecutionContextMode` — nežinoma NE TUŠČIA reikšmė
  fail-closed į `required` (nežinia apie saugumo režimą negali švelninti
  režimo; garsaus log'o šioje grynoje funkcijoje nėra kam priimti, o
  signatūros keisti negalima — žr. Draudžiama); `undefined`/tuščia lieka
  `preferred`. `interfaces-cli-dispatch-plan.test.ts:133` pin'as
  (`"netinkamas"` → `preferred`) perrašomas į `required` su komentaru.
- Testų lūkestis: gate atvejai 168-170/221-222 elgesio NEkeičia — esami
  `interfaces-cli-dispatch-plan.test.ts` gate testai lieka žali be
  silpninimo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei architektas (A)
šakoje nuspręstų, kad be realaus wiring (naujo kvietėjo composition
sluoksnyje ar porto) sprendimas neturi prasmės — wiring yra už šio task'o
ribų ir reikalauja atskiro task'o.

## Neįtraukta
- `symbol_slices` canary įjungimas ar jo konfigūracijos keitimas — čia tik
  suderinamas kelias, kuriuo canary kada nors eis.
- CLI kelio (`claude-dispatch/command.ts`) freshness logika — veikia,
  neliečiama.
- Gate politikos keitimas (168-170 „unchecked + pack su pjūviais = stale"
  ir 221-222 refuse ne-repair source-change) — fail-closed lieka; jei
  architekto verdiktas reikalautų ją švelninti, tai atskiras
  human-review sprendimas, ne šis task'as.
- Naujo produkcinio `claudeAdapterDispatch` kvietėjo kūrimas — atskiras
  task'as, jei kada prireiks.
