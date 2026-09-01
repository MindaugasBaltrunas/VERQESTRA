# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/context-pack/effective-compression-policy.ts`
`readContextCompressionArrestState` (dabar 63-78 eil.) skiria „failo nėra"
(`undefined` → default view) nuo „skaitymas išmetė" (catch →
`unreadable: true`) — ALREADY_IMPLEMENTED: cituok abi šakas ir testą kaip
įrodymą.

## Tikslas
Audito P2 (2026-09-01): arrest kill-switch tyliai perrašomas po skaitymo
klaidos. Patikrinta `effective-compression-policy.ts:67`:
`readTextFileIfExists(...).catch(() => "")` — METANTIS skaitymas (teisės,
FS klaida; ne „failo nėra", kurį `readTextFileIfExists` jau grąžina kaip
`undefined`) paverčiamas tuščiu stringu, o 68-70 eil. tuščias turinys
grąžina `{ state: default, unreadable: false }`. Tai TIESIOGIAI prieštarauja
to paties bloko doc'ui (60-61 eil.): „neperskaitomas turinys yra skaitomas
atsakymas `unreadable` (arrests everything)". Sąveika su rašytoju:
`compression-arrest-observer.ts:46-57` unreadable guard'as (kuris saugo nuo
markerio perrašymo, kai jo nepavyko perskaityti) APEINAMAS — observer'is
mato „švarų default" ir operatoriaus markerį (skaitiklius, langą, arrest
sąrašą) tyliai resetina. Sprendimas: catch šaka grąžina
`parseContextCompressionArrestState`-ekvivalentų unreadable view
(`unreadable: true`, arrests everything — kaip JSON.parse lūžio šaka 74-76
eil. jau daro), o `undefined`/tuščias lieka default. Fail-closed kryptis
kill-switch'ui: nežinia sustabdo kompresiją, ne įjungia.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/effective-compression-policy.ts`
- `src/tests/context-pack.test.ts` (effective policy testai gyvena čia;
  jei arrest skaitymo atvejai natūraliau gula kitame context-pack teste —
  tas failas vietoje šio, įrašyti į ataskaitą)
- `src/tests/context-pack-guards.test.ts` (context-pack.test.ts spillover
  failas prie 500 eil. ribos; 2026-09-01 dispatch parkavosi su „changed
  files outside allowed paths: src/tests/context-pack-guards.test.ts" —
  worker'iui arrest skaitymo testams objektyviai reikėjo šio failo)

Draudžiama:
- `src/application/context-pack/compression-arrest-observer.ts` (guard'as
  teisingas — jam tiesiog grąžinama tiesa)
- `src/application/context-pack/compression-cache-sources.ts` (cache
  šaltinio projekcija nekinta; unreadable jau turi savo kelią)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `effective-compression-policy.ts` (63-78 eil.): `.catch(() => "")`
  pakeisti šaka, kuri skaitymo IŠIMTĮ paverčia unreadable view (ta pati
  forma kaip `parseContextCompressionArrestState("not json")` kelias);
  `undefined` (failo nėra) ir tuščias turinys LIEKA default be unreadable.
  Doc'as (59-62 eil.) po pataisos tampa teisingas — atnaujinti tik jei
  formuluotė reikalauja.
- Testų lūkestis: (1) regresija — fs portas, metantis skaitymo klaidą →
  `unreadable: true` ir efektyvi politika arrest'ina visas feature'es;
  (2) failo nėra (`undefined`) → default, `unreadable: false`; (3) tuščias
  failas → default; (4) sugadintas JSON → esamas unreadable elgesys žalias.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
- ATVIRAS 2026-08-29 kompresijos audito klausimas — arrest kill-switch be
  0037 atribucijos (FORWARD eksportas be kvietėjo) — atskira tema, čia
  taisomas tik skaitymo fail-open; jei vykdytojas tame kelyje pastebės
  atribucijos sąsajų, fiksuoti ataskaitoje, ne spręsti.
- Observer'io reset politikos keitimai — guard'o logika lieka kokia yra.
