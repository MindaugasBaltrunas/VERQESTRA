# VERQESTRA — darbo taisyklės

VERQESTRA yra kanoninis AG Loop perstatymas švaria architektūra. Šiuo metu vyksta **migracija**
iš etalono: `D:\React\AG_loop` yra **read-only** šaltinis, skaitomas absoliučiu keliu.

## Pirmas autoritetas

1. `README.md` — produkto ribos.
2. `src/tests/architecture-gates.test.ts` — sluoksnių, dydžio ir higienos vartai. Jei taisyklė
   ir šis failas prieštarauja, laimi failas: jis bėga.
3. Etalono elgesys — perkeliamas 1:1, **išskyrus** atvejus, kai jis yra įrodoma spraga
   (žr. „Nukrypimai nuo etalono").

## Sluoksnių ribos (tikrina `pnpm test`)

```text
domain          → domain, shared
application     → application, domain, shared
infrastructure  → infrastructure, application, domain, shared
interfaces      → interfaces, application, domain, shared      (NE infrastructure)
composition     → viskas
```

- **`domain` sluoksnyje draudžiami VISI `node:` importai** (net `node:path`). `shared` ir
  `application` gali `node:path` ir `node:crypto`.
- `interfaces` efektus gauna per portus; `composition` juos suriša (manual DI).
- Kiekvienas src failas — **≤ 500 eilučių**, įskaitant testus.
- Tik LF, jokio NUL, NFC normalizacija.
- Importų grafas — aciklinis, net type-only ryšiams (tipai keliauja į atskirą `-model` failą).

## TypeScript

`exactOptionalPropertyTypes` (opcionalūs laukai — per sąlyginius spread'us),
`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature` (Record prieiga per bracket).
Jokio naujo `any` ar `@ts-ignore` be techninio pagrindimo.

## Patikros

```bash
pnpm typecheck && pnpm test
```

Abi privalomos prieš kiekvieną commit'ą. Testai neweakinami, kad praeitų — jei testas teisus,
o kodas ne, taisomas kodas.

### Greitas ciklas (nereikia sukti visų testų)

Du terminalai — inkrementinis build ir tik paliestų testų perleidimas:

```bash
pnpm build:watch      # tsc --watch: perkompiliuoja tik pasikeitusius failus
pnpm test:watch       # node --test --watch: perleidžia tik paveiktus testus
```

Taškinis paleidimas, kai jau žinai, kur žiūrėti (reikia šviežio `dist`):

```bash
pnpm test:file dist/tests/interfaces-hooks-pre-hooks.test.js
pnpm test:grep "readme guard"
pnpm typecheck:watch  # tik tipai, be emit — greičiausias signalas
```

### Lint yra vartų dalis

`pnpm test` bėga tokia tvarka: **lint → build → testai → `typecheck:ui` → `test:ui`**. Lint pirmas,
nes jis pigiausias ir gaudo tai, ko `tsc` nemato (pakibę Promise'ai, `any`, `@ts-ignore`,
nepanaudoti kintamieji).

`ui-app` pakopa pridėta 2026-08-26 po incidento: task 028 pakeitė `WavesPanel` duomenų kelią, jo
testas liko stub'inantis globalų `fetch`, ir septyni raudoni testai išgyveno kelis ciklo
dispatch'us — šaknies `pnpm test` jų nematė, tad ciklas laikė medį žaliu. CI juos gaudė visą laiką,
bet **ciklas CI nepaleidžia: jam `pnpm test` yra vartas**. Invariantą saugo
`src/tests/gate-covers-ui-app.test.ts`.

`mobile-*` ir `AG/benchmark` į `pnpm test` NEĮTRAUKTI sąmoningai — jų `node_modules` čia nėra, tad
įtraukti reikštų padaryti vartus raudonus visiems, kas nepaleido tų paketų diegimo. Keisdamas tuos
paketus, patikras paleisk vardu (`pnpm test:mobile`, `pnpm test:benchmark`) ir įrašyk į task'o
`## Patikra`.

Iš to plaukia taisyklė: **nauja lint taisyklė įjungiama tik ją paleidus ant viso `src` ir
ištaisius radinius**. Taisyklė, įjungta „pažiūrėti, ką ras", sustabdo visą migraciją, o ne
pagerina kodą.

Kai reikia atskirti signalus (pvz. lint raudonas, o tikrini testų regresiją):

```bash
pnpm lint        # tik lint
pnpm test:only   # build + testai, be lint
```

### Pack'o semantika ir kešas

Pakeitęs bet ką, kas veikia **sukurto context pack'o turinį** (retrieval, reitingavimas,
biudžetas, `contextPackSchema` laukų prasmė), **pakelk `CONTEXT_CACHE_VERSION`**. Šaltinių
hash'ai mato duomenis, ne kodą: nepakėlus, senas įrašas grįžta kaip `hit` ir tyliai anuliuoja
pataisymą. Derinimo konstantos į raktą patenka automatiškai, loginiai pakeitimai — ne.

Renderio (`execution-context.md`) pakeitimams kelti NEreikia: jis generuojamas iš naujo
kiekvieno hit'o metu.

Prieš commit taip pat:

```bash
grep -rn '\*/' src --include=*.ts        # `*/` JSDoc'e uždaro komentarą ir sugriauna failą
grep -rcaP '\x00|\r' src | grep -v ':0$' # NUL ir CRLF
```

## Runtime keliai

`vq/{state,config,logs,project,architecture,generated}` — šio produkto runtime.
`AG/tasks`, `AG/openspec`, `AG/spec/changes` ir `AG/benchmark` lieka `AG/…` (eilės ir paketo
kontraktai).

## Užduočių kūrimas — PRIVALOMA per etaloną

Kiekvienas `AG/tasks` failas kuriamas, perrašomas ar skeliamas TIK pagal
`AG/tasks/examples/000-etalonas.md` — pirmas žingsnis visada yra jo perskaitymas, ne rašymas
iš atminties. Interaktyviame kelyje naudok `task-author` agentą (`.claude/agents/task-author.md`)
arba laikykis jo darbo eigos pats: kiekvienas `## Failai` kelias patikrintas Glob/Grep prieš
deklaruojant, priklausomybės tik į queue/done, skėlimo vaikų scope nepersidengia,
`HUMAN-REVIEW-APPROVED` — tik su operatoriaus citata. 2026-08-28 penki task'ai parkavosi
human-review vien dėl iš atminties rašytų `## Failai` sąrašų — etalonas yra tos paros kaina.

## Užduočių `## Failai` konvencija

`## Failai / Leidžiama` yra ne tik rašymo riba — tai vienintelis įėjimas, iš kurio
planuoklė sprendžia, ar dvi užduotys gali suktis lygiagrečiai. Todėl:

**Deklaruok konkrečius kelius, įskaitant testus.** Ne `src/tests/**`, o
`src/tests/task-execution-orchestration.test.ts`. Jei tikslus vardas dar nežinomas —
įrašyk numatomą: klaidingas konkretus kelias yra pastebimas ir taisomas, o wildcard'as
atima lygiagretumą tyliai.

`**` leidžiamas TIK kai apimtis tikrai neribota (pvz. viso paketo migracija). Tada
užduotis sąmoningai atsisako lygiagretumo — tai sprendimas, ne numatytoji reikšmė.

### Kaina

Matavimas (tikras `evaluateWriteSetIndependence`, 2026-08-26): dvi užduotys su
konkrečiais keliais gauna verdiktą „write set'ai nesikerta nė vienoje dimensijoje" —
lygiagretumas veikia. Tos pačios užduotys su `src/tests/**` gauna
`1 įrodymo spraga: wildcard-scope`, ir spraga **vienoje** pusėje daro porą nuoseklia
net be jokios sankirtos.

Realus pavyzdys: `032-baigties-priezastis-…` × `033-skaidymas-negimdo-…` blokavosi dviem
priežastimis vienu metu — `persidengiantis glob/glob scope: 'src/tests/**' vs
'src/tests/**'` PLIUS dvi `wildcard-scope` spragos. Abi kilo iš tos pačios `## Failai`
eilutės, nors užduotys lietė visiškai skirtingus modulius (`domain/diagnosis` ir
`application/task-execution`) ir skirtingus testų failus.

Kaina yra būtent tokia: `src/tests/**` parašyti trumpiau vienam autoriui, o sumoka visa
eilė — kiekviena tokia pora praranda slot'ą ir sukasi nuoseklai. Dvi papildomos eilutės
su tikrais keliais atperka save jau pirmoje bangoje.

## Nukrypimai nuo etalono

Perkeliant leidžiama uždaryti etalono spragą, bet **niekada tyliai**. Nukrypimas rašomas į
tris vietas: commit'o ataskaitą, etalono `tasks.md` anotaciją ir `migration-coverage.json`,
kartu su priežastimi. Kryptis visada griežtinanti: naujų praleidimų neatsiranda.

Etalone liesti **tik** `AG/openspec/changes/ag-loop-v2-7-architecture-upgrade/tasks.md`
progreso anotacijas. Jokio kito AG_loop failo.

## Ataskaita po kiekvienos dalies

```text
Pakeista:
- ...

DB ribos:
- Reads: ...
- Writes: ...

Job tipai:
- ...

Testai:
- ...

Rizikos:
- ...

Ko neliečiau:
- ...
```

## Kada stabdyti ir klausti

Darbas eina per dalis be sustojimų; patikros taškas — po epiko. Nedelsiant sustoti, kai:
priklausomybių ar public API kontrakto keitimas; failų trynimas/pervadinimas, kurio užduotis
neapima; migracija reikalautų susilpninti testą ar guard'ą; etalono elgesys atrodo klaidingas
(siūlyti, ne spręsti tyliai); dvi dalys iš eilės krenta dėl tos pačios priežasties.
