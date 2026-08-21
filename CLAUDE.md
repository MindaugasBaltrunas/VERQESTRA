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

`pnpm test` bėga tokia tvarka: **lint → build → testai**. Lint pirmas, nes jis pigiausias ir
gaudo tai, ko `tsc` nemato (pakibę Promise'ai, `any`, `@ts-ignore`, nepanaudoti kintamieji).

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
