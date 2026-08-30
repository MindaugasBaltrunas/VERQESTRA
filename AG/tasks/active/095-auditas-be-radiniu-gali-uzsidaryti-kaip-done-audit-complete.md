# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/diagnosis/dispositions.ts` `NoCommitDoneInputs` jau turi
`hasAuditCompleteMarker` (ar analogišką audito markerio) lauką IR
`src/domain/diagnosis/stream-log.ts` turi `AUDIT_COMPLETE` atpažinimo
funkciją šalia `logHasAlreadyImplementedMarker` — ALREADY_IMPLEMENTED:
nurodyk `failas:eilutė` abiem vietoms kaip įrodymą.

## Tikslas
Audito tipo task'ai — kurių deliverable yra ✅/❌ ataskaita su
`failas:eilutė` įrodymais, o ne kodo pakeitimas — sistemingai parkuojasi į
human-review, kai auditas nieko taisytino neranda. Trys atvejai vienos
paros (`vq/logs/task-events.jsonl:417,418,421`, 2026-08-30):
`069-galutinis` „clean tree without work evidence", `069-a-02` „executor
made no write-tool calls", `069-d-05` „Claude did not create a new
commit" — visų lokali diagnozė buvo verdict=done (checks žali), atmetė
užbaigimo sargas.

Mechanizmas: `src/application/task-execution/verify-task.ts:146-186` done
leidžia tik su produkto commit'u nuo baseHead ARBA per no-commit
disposition (`src/domain/diagnosis/dispositions.ts:246-269`
`resolveNoCommitDisposition`), kuri be commit'o reikalauja
ALREADY_IMPLEMENTED markerio + įrodymų. Audito task'ams
ALREADY_IMPLEMENTED semantiškai netinka: jų deliverable yra ataskaita, ne
„darbas jau padarytas" (`AG/tasks/done/069-galutinis-dashboard-atitikties-auditas-ir-perbuild.md:10`
— „Rezultatas — ataskaita…"; failas Žingsnio 0 sekcijos apskritai neturi,
tad markerio kelio jam nėra). Palyginimui tos pačios paros `069-b-03` ir
`069-c-04`, kurie ALREADY_IMPLEMENTED šabloną turėjo, užsidarė done per
markerį (`task-events.jsonl:419,420`). Išvada: sėkmingas nieko neradęs
auditas šiandien NEGALI užsidaryti kaip done jokiu keliu — kiekvienas
toks bėgimas degina dispatch'ą ir operatoriaus triažą.

Sprendimo kryptis (numatytoji — A): dispositions gauna TREČIĄ siaurą
išimtį — vykdytojo ataskaitos eilutė `AUDIT_COMPLETE: <santrauka>` +
nepriklausomas skaitytojo signalas `writeActivity === "no-writes"` +
švarus produkto medis → done. Tai TIKSLIAI 060 ALREADY_IMPLEMENTED
išimties struktūra (žr. `dispositions.ts:253-265` komentarą apie DVIGUBĄ
įrodymą): žodis be įrodymo neuždaro. Atmesta alternatyva B (audito
task'ai committina ataskaitą į repo failą, pvz. `docs/audits/` — commit'as
atsiranda natūraliai): ji keičia task'ų šablonus, ne kodą, ir nepadeda
jau sugeneruotiems audito task'ams; galutinį pasirinkimą su pagrindimu
daro architektas (žr. `## Stop`).

Pastaba dėl `writeActivity` patikimumo: attempt-scoped sesijos žurnalo
persistinimas jau įgyvendintas (task 090 su vaikais guli `done/`), tad
papildomos priklausomybės nereikia.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/diagnosis/dispositions.ts`
- `src/domain/diagnosis/stream-log.ts`
- `src/application/task-execution/verify-task.ts`
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/application/task-execution/run-coordinator-terminal.ts` (tik jei
  įvedama nauja `via`/priežasties eilutė terminaliniam perėjimui — kitaip
  neliesti ir pažymėti ataskaitoje)
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/tests/domain-diagnosis-audit-complete.test.ts` (numatomas naujas —
  patikrinta Glob'u, failo nėra; jei atvejai natūraliau gula į esamą
  `src/tests/domain-diagnosis-already-implemented.test.ts` praplėtimą —
  tas failas vietoje šio, įrašyti į ataskaitą)
- `src/tests/domain-diagnosis-already-implemented.test.ts`
- `src/tests/quality-gates-verify.test.ts` (čia gyvena
  `logHasAlreadyImplementedMarker` atpažinimo testai — naujo markerio
  atpažinimo atvejai greta)
- `src/tests/fixtures/characterization/diagnosis-dispositions.json`
- `src/tests/characterization-diagnosis.test.ts` (tik jei fixture
  papildymas reikalauja įvesties mapping'o pakeitimo)
- `src/tests/helpers/fake-task-run-ports.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `AG/tasks/examples/000-etalonas.md` (šablonų keitimas — B kryptis, ne čia)
- `src/interfaces/**`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `src/domain/diagnosis/stream-log.ts`: šalia
  `logHasAlreadyImplementedMarker` (40-46 eil.) pridėti `AUDIT_COMPLETE`
  markerio atpažinimą ta pačia dviguba paieška (žalias log'as + result
  envelope per `extractResultEnvelopeFromStreamJsonLog`) — stream-json
  pamoka iš 1048/1049 galioja ir naujam markeriui. Markerio forma:
  ataskaitos eilutė, prasidedanti `AUDIT_COMPLETE` (tiksli regex forma —
  architekto sprendimas, bet `AUDIT_COMPLETE: <santrauka>` privalo būti
  atpažįstama).
- `src/application/task-execution/run-coordinator-ports.ts`:
  `DiagnosisRulesPort` (~245 eil.) naujas metodas markerio skaitymui;
  spręsti, ar `AlreadyImplementedVia` (24 eil.) reikia naujos reikšmės, ar
  užtenka esamos `"marker"` — atskira reikšmė duoda tikslesnę
  `task-events` priežastį, bet plečia union'ą, kurį vartoja
  `run-coordinator-terminal.ts:176-181`.
- `src/domain/diagnosis/dispositions.ts`: `NoCommitDoneInputs` (~203 eil.)
  naujas laukas; `resolveNoCommitDisposition` (246-269 eil.) trečia siaura
  šaka: audito markeris + `writeActivity === "no-writes"` +
  `productDirtyCount === 0` → `"done"`. Be nepriklausomo no-writes
  patvirtinimo (`"unknown"`, `"wrote"`, laukas nepaduotas) — elgesys
  NEKINTA (human-review/rollback kaip dabar): auditas, kuris kažką rašė,
  bet neužcommitino, privalo likti rollback šakoje, kad darbas nedingtų.
  Apsvarstyti tikslesnę `resolveNoCommitReviewReason` eilutę atvejui
  „audito markeris yra, bet no-writes nepatvirtintas".
- `src/application/task-execution/verify-task.ts` (161-186 eil.): skaityti
  naują markerį per port'ą, paduoti į `noCommitInputs`, parinkti `via`
  reikšmę `done-already-implemented` (ar naujam) perėjimui.
- `src/composition/loop/coordinator-execution-adapters.ts` (~200 eil.):
  prijungti kanoninę stream-log implementaciją prie port'o — greta esamo
  `hasAlreadyImplementedMarker` surišimo.
- `src/tests/helpers/fake-task-run-ports.ts` (~216 eil.): fake port'as
  gauna naujo markerio atpažinimą ta pačia shape kaip
  `hasAlreadyImplementedMarker`.
- Testų lūkesčiai: (a) audito markeris + no-writes + švarus medis → done;
  (b) audito markeris be no-writes patvirtinimo → human-review; (c) audito
  markeris + dirty produkto failai → ne done (rollback/human-review kaip
  dabar); (d) markerio nėra → visos esamos šakos baitas-į-baitą nepakitusios
  (charakterizacijos fixture papildoma naujais atvejais, seni įrašai
  nekeičiami); (e) `AUDIT_COMPLETE` atpažįstamas ir žaliame log'e, ir
  stream-json result envelope; tekstas „tekste minimas AUDIT_COMPLETE
  žodis" viduryje sakinio — NEatpažįstamas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. STOP ir klausk operatoriaus, jei
architektas nusprendžia, kad teisingesnė kryptis yra B (committinama
ataskaita per task šablonus, be kodo keitimo) arba kad išimčiai reikia
silpninti esamą ALREADY_IMPLEMENTED / no-writes sargų elgesį — abu yra
užbaigimo kontrakto sprendimai, kurių šis task'as vienašališkai nedaro.

## Neįtraukta
Istorinių 2026-08-30 parkavimų valymas (069-galutinis, 069-a-02,
069-d-05 jau sutriažuoti ranka — bucket'ų kilnojimas yra operatoriaus
veiksmas). 069 šeimos task'ų turinys. B krypties šablonų/generatoriaus
keitimas (`000-etalonas.md` ar task generavimo kodas) — jei architektas
jį rekomenduos, tai atskiras task'as po operatoriaus sprendimo. UI ir
`interfaces` sluoksniai — `task-events` priežasties eilutė keliauja per
esamą kanalą, naujo endpoint'o nereikia.
