# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/hooks/pre-hooks.ts` žinomų task id rinkimas (dabar
`knownTaskIdsFromLedger`, ~169 eil.) jau skaito `AG/tasks/queue` ir
`AG/tasks/done` katalogų failų vardus (grep `listDirectory` arba
`AG/tasks` tame faile duoda radinį rinkimo funkcijoje) —
ALREADY_IMPLEMENTED: nurodyk funkciją ir eilutes, kuriose bucket'ų
listingas patenka į `validateTaskAgainstEtalonas` kvietimą.

## Tikslas
Pre-write etalono vartas (071 darbo kodas, dabar done bucket'e) žinomus
task id ima TIK iš `vq/state/task-ledger.json` raktų
(`src/interfaces/hooks/pre-hooks.ts:169`, `knownTaskIdsFromLedger`). Bet
ledger'yje egzistuoja tik task'ai, jau turėję būsenos perėjimą — niekada
nebėgęs queue task'as jame NEEGZISTUOJA. Įrodymas 2026-08-30:
`AG/tasks/queue/075-preserved-ref-retencija-ir-hooks-log-archyvas.md` guli
queue, o `grep 075-preserved-ref vq/state/task-ledger.json` — 0 radinių.
Pasekmė: `priklausomybe-unknown-id` (src/domain/tasks/etalonas-rules.ts:181-189)
klaidingai blokuoja BET KOKĮ rašymą į task failą, kurio `## Priklausomybės`
nurodo teisėtą, bet dar nebėgusį queue task'ą. Realus incidentas 2026-08-30
~07:15: 083-preserved-ref-state-sutaikinimas.md pataisos įrašyti neįmanoma —
hook'as atmeta su `priklausomybe-unknown-id: 075`. Komentaras
pre-hooks.ts:163-168 („Ledger'io raktai JAU yra kanoniniai task id...
vienintelis šaltinis") — įrodomai klaidinga prielaida, taisoma kartu.
Sprendimo kryptis: žinomų id visata privalo atitikti etalono taisyklę „TIK
task'ų id iš queue arba done bucket'ų" — šaltinis yra bucket'ų katalogų
(`AG/tasks/queue`, `AG/tasks/done`) failų vardai be `.md`, SĄJUNGOJE su
ledger'io raktais (backward compatibility: active/delegated task'ai matomi
per ledger'į). Alternatyva „palikti vien ledger'į ir pildyti jį queue
įrašais" atmesta: ledger'is yra būsenos perėjimų žurnalas, ne eilės
katalogas, ir jo pildymas vien dėl validacijos iškreiptų jo semantiką.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/hooks/pre-hooks.ts`
- `src/interfaces/hooks/protocol.ts` (tik jei listingo portas dedamas į
  `HookFsPort`; jei architektas renkasi atskirą `PreHookPorts` lauką —
  šio failo neliesti, įrašyti į ataskaitą)
- `src/composition/hooks/pre-adapters.ts`
- `src/domain/tasks/etalonas-rules.ts` (tik jei prireiktų signatūros ar
  klaidos žinutės pataisos; šiaip neliesti)
- `src/tests/interfaces-hooks-pre-hooks.test.ts`
- `src/tests/interfaces-hooks-pre-hooks-etalonas.test.ts` (numatomas
  naujas: esamas pre-hooks testų failas jau ~529 eilučių ir kerta 500
  eilučių vartą — nauji etalono vartų testai eina čia, esamus etalono
  struktūros testus leidžiama perkelti; jei vardas parenkamas kitoks —
  tas failas vietoje šio, įrašyti į ataskaitą)
- `src/tests/domain-tasks-etalonas-rules.test.ts` (tik jei keičiamas
  etalonas-rules.ts)

Draudžiama:
- `src/domain/policies/**`
- `src/interfaces/hooks/post-hooks.ts`
- `src/interfaces/hooks/post-write.ts`
- `vq/state/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `src/interfaces/hooks/pre-hooks.ts`: žinomų id rinkimą praplėsti iki
  sąjungos — `AG/tasks/queue` ir `AG/tasks/done` katalogų `.md` failų
  vardai (be plėtinio) + esami ledger'io raktai. Katalogo listingui
  reikia porto: `PreHookPorts` deps jo dabar neturi
  (`fs: HookFsPort` moka tik exists/read/write/append/mkdir), o
  infrastruktūroje `nodeFsAdapter.listDirectoryIfExists` jau egzistuoja
  (`src/infrastructure/fs/node-fs-adapter.ts:302`) — surišti jį
  `src/composition/hooks/pre-adapters.ts` (`preHookPorts`), portą
  padarant PRIVALOMĄ pagal to failo taisyklę „joks portas negali virsti
  undefined numatytuoju".
- Klaidų kryptis konservatyvi: nerandamas ar neperskaitomas bucket'o
  katalogas duoda tuščią TO šaltinio indėlį (kiti šaltiniai lieka) —
  taisyklė gali tik SUSIAURINTI leidžiamas nuorodas, niekada neišplėsti.
- Ištaisyti klaidingą komentarą pre-hooks.ts:163-168 apie ledger'į kaip
  vienintelį šaltinį.
- Testų lūkestis: (1) dar nebėgęs queue task'as (yra queue kataloge, nėra
  ledger'yje) kaip `## Priklausomybės` nuoroda PRAEINA; (2) niekur
  neegzistuojantis id tebeBLOKUOJA su `priklausomybe-unknown-id`;
  (3) done bucket'o task'as kaip nuoroda praeina; (4) sugadintas ar
  nerandamas bucket'o katalogas nepraleidžia neegzistuojančio id
  (konservatyvi pusė); (5) vien ledger'yje esantis id (active/delegated)
  tebepraeina — backward compatibility.
- Jei perkeliami esami etalono struktūros testai į naują failą —
  perkėlimas be elgesio keitimo, abu failai lieka ≤ 500 eilučių.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei listingo porto
pridėjimas į `HookFsPort` verstų keisti kitų hook'ų failus ar jų testų
fake'us už deklaruotų failų ribos — tada portas dedamas į `PreHookPorts`
atskiru lauku, o jei ir tai neišeina, klausk.

## Neįtraukta
`done/**` ir `human-review/**` bucket'ų validacijos įjungimas (sąmoningas
071 sprendimas, lieka). Etalono taisyklių turinio keitimas
`etalonas-rules.ts` (be būtinos signatūros/žinutės pataisos). `delegated`
bucket'o kaip žinomų id šaltinio klausimas — etalonas leidžia
priklausomybes tik į queue/done, delegated matomas per ledger'io sąjungą.
083-preserved-ref-state-sutaikinimas turinio taisymas — atsiblokuoja
savaime, kai šis vartas ima matyti 075.
