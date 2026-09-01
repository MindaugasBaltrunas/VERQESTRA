# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/dead-export-gate.test.ts` turi failų lygio našlaičių patikrą
(src failas be NĖ VIENO importuotojo pagal kelio rezoliuciją → pažeidimas
`orphan-file`, su aiškiu entrypoint allowlist'u) IR
`src/infrastructure/persistence/code-index-store.ts` nebeegzistuoja —
ALREADY_IMPLEMENTED: cituok patikros kodą, allowlist'ą ir Glob rezultatą
kaip įrodymą.

## Tikslas
Audito P2 su gyvu įrodymu (2026-09-01): 099 merge atnešė barrel/testų
valymą, bet paties `src/infrastructure/persistence/code-index-store.ts`
trynimas NEATVYKO — failas guli diske kaip PILNAS našlaitis (Glob
2026-09-01: egzistuoja; importuotojų nulis), o `dead-export-gate.test.ts`
ŽALIAS. Tikrasis praslydimo mechanizmas patikslintas kodu (audito hipotezė
„failas ne importų grafe" netiksli — vartas grafo apskritai neturi): vartas
yra TOKEN'INIS — `usedElsewhere` (326-341 eil.) simbolį laiko gyvu, jei jo
VARDĄ mini bet kuris kitas failas. Našlaičio visi septyni eksportai
(`codeIndexDir`, `codeIndexPath`, `writeCodeIndex`, `readCodeIndex`,
`codeIndexExists`, `checkCodeIndexFreshness`, `createManifest`) turi
BENDRAVARDŽIUS dvynius kanoniniame
`application/code-intelligence/store/code-index-store.ts`, kurio kvietėjai
tuos tokenus mini — vardų kolizija pridengia visą mirusį failą. Tai
sisteminis aklumas: pilnas failo dublikatas su tais pačiais vardais vartui
NEMATOMAS iš principo. Sprendimas: (1) vartas papildomas FAILŲ lygio
našlaičių patikra — produkcinis src failas, kurio KELIO neimportuoja (nei
`import ... from`, nei `export ... from`, nei dinaminis `import(...)`) nė
vienas kitas src failas ir kuris nėra aiškiame entrypoint allowlist'e, yra
pažeidimas `orphan-file`; (2) 099 liekana IŠTRINAMA šiame task'e (KARTU
šaka — kad naujas vartas nenusileistų raudonas), trynimas yra aiški šio
task'o apimtis su 099 dalinio merge pagrindimu.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/tests/dead-export-gate.test.ts`
- `src/infrastructure/persistence/code-index-store.ts` (TRINAMAS — 099
  dalinio merge liekana; 099 guli human-review, jį requeue'inus jo
  Žingsnis 0 ras failą dingusį ir užsidarys ALREADY_IMPLEMENTED — sankirta
  sąmoninga ir dokumentuota, žr. Neįtraukta)

Draudžiama:
- `src/application/code-intelligence/store/code-index-store.ts` (kanoninė
  realizacija — nekeičiama)
- `src/infrastructure/index.ts` (barrel jau išvalytas 099 merge — jo
  neliesti)
- `src/tests/infrastructure-persistence.test.ts` (jau išvalytas 099 merge)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `dead-export-gate.test.ts`: `collect` (208-232 eil.) papildomai renka
  kiekvieno failo importo/re-eksporto/dinaminio importo SPECIFIKATORIUS
  (santykinius `./`/`../` kelius, išspręstus į repo-santykinius `.ts`
  kelius; `.js` sufiksas ESM importe → `.ts` šaltinis). Naujas testas
  „gate: kiekvienas produkcinis failas turi importuotoją arba yra
  entrypoint": produkcinis failas (ne `tests/`), kurio kelio nemini nė
  vieno KITO failo specifikatoriai ir kurio nėra `KNOWN_ENTRYPOINTS`
  sąraše, → pažeidimas `orphan-file` su failo vardu.
- SVARBI SKIRTIS nuo simbolių lygio: `withoutReExports` (162-171) simbolių
  patikrai re-eksportus ignoruoja TEISINGAI, bet failų lygio patikrai
  `export ... from "./x.js"` YRA importas — barrel'io taikinys nėra
  našlaitis (kitaip kiekvienas index.ts taikinys taptų pažeidimu).
- `KNOWN_ENTRYPOINTS`: aiškus, komentuotas sąrašas (KNOWN_UNCALLED
  stiliumi, 234-284 precedentas) — bent `cli.ts` (dist/cli.js yra bin ir
  hook'ų kvietimo taškas); kiekvienas kitas kandidatas įtraukiamas TIK su
  priežasties komentaru, o dviejų krypčių drausmė ta pati kaip
  KNOWN_UNCALLED (347-358): atsiradęs importuotojas daro sąrašo eilutę
  nebeteisingą.
- Savipatikra tame pačiame faile (301-324 precedentas): sintetinė failų
  aibė — (1) našlaitis su bendravardžiais eksportais (šio incidento klasė)
  → `orphan-file`; (2) failas, importuojamas TIK per `export * from` barrel
  → NE našlaitis; (3) entrypoint → NE; (4) testų failai neskaičiuojami.
  Patikros logika iškeliama į gryną funkciją, kad savipatikra ją maitintų
  sintetiniais įėjimais be realaus FS.
- Ištrinti `src/infrastructure/persistence/code-index-store.ts` — PRIEŠ
  trynimą persitikrinti Grep'u, kad kelio (`persistence/code-index-store`)
  nemini joks src failas (2026-09-01 patikrinta: nemini niekas).
- Testų lūkestis: `pnpm test` žalias — realiame medyje po trynimo našlaičių
  nėra (jei patikra rastų DAUGIAU realių našlaičių — kiekvienas arba
  trinamas su tuo pačiu Grep įrodymu, arba gauna KNOWN_ENTRYPOINTS/atskiro
  baseline eilutę su priežastimi; tylus praleidimas draudžiamas).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei realiame medyje
atsirastų našlaičių, kurių trynimas nėra akivaizdžiai saugus (pvz. failas
atrodo miręs, bet jo kelią mini konfigas ar ne-TS kodas) — tokio failo
likimas yra operatoriaus sprendimas, ne baseline eilutė „kad praeitų".

## Neįtraukta
- SANKIRTA SU 099 (human-review): trinamas failas deklaruotas 099
  Leidžiamoje; priklausomybės į human-review gyventoją deklaruoti negalima
  (pati etalono taisyklė), todėl sankirta sprendžiama turiniu — po šio
  task'o 099 requeue baigsis ALREADY_IMPLEMENTED su Glob įrodymu; jei
  operatorius 099 requeue'ins PIRMIAU, šio task'o Žingsnis 0 dalis dėl
  trynimo išsipildys savaime.
- Simbolių lygio vardų kolizijos problema apskritai (tas pats vardas
  dviejuose gyvuose moduliuose maskuoja vieno mirtį) — failų lygio patikra
  uždaro PILNO našlaičio atvejį; dalinio šešėliavimo (gyvame faile miręs
  bendravardis eksportas) aptikimas reikalautų tikro importų rezolverio
  simbolių lygyje — atskiras svarstymas, jei atsiras įrodymų.
- Importų grafo priemonės (`code-intelligence` indeksas) panaudojimas
  vietoj savarankiško parsinimo — vartas sąmoningai savarankiškas ir be
  priklausomybių nuo produkto kodo (jis tikrina tą kodą).
