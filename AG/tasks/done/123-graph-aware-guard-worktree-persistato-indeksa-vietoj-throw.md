# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/code-intelligence/query/guard.ts`
`assertFreshCodeIndexForGraphAwareTask` (dabar 11-32 eil.) radęs nešviežią/
trūkstamą indeksą PIRMA bando deterministinį `buildCodeIndex` rebuild'ą (kaip
`ensureFreshCodeIndexForExistingCodeTask` tame pačiame faile) ir meta klaidą
TIK kai rebuild'as pats krito — ALREADY_IMPLEMENTED: cituok rebuild šaką ir
jos testą kaip įrodymą.

## Tikslas
Gyvo loop bėgimo P0 (2026-09-01 08:32 diagnozė): graph-aware task'as
worktree kopijoje miršta AMŽINU crash ciklu be progreso. Log įrodymas:
08:32:50 `PHASE FAILED task=097 phase=preflight … code index manifest is
missing. Run the code-index build command` — worktree viduje. Mechanizmas
patikrintas: šviežias worktree neturi `vq/` (gitignore'intas, checkout'e
neatsiranda), o `WORKTREE BOOTSTRAP` (`worktree-runtime.ts`) aprūpina tik
dist kopiją, node_modules junction'us ir `vq/config`
(`composition/loop/command.ts:322` — configDirs TIK `config`; `vq/state/
code-index` neaprūpinamas niekur). Guard'as
`assertFreshCodeIndexForGraphAwareTask` (`guard.ts:26-31`), kviečiamas
claude-preflight komandoje (`commands-ops.ts:207`), radęs trūkstamą manifestą
META klaidą — skirtingai nei TO PATIES failo
`ensureFreshCodeIndexForExistingCodeTask` (91-122 eil., etalono task 975),
kuris pirma daro deterministinį `buildCodeIndex` rebuild'ą ir blokuoja tik
kai rebuild'as pats negali. Ciklo anatomija: task'as parkuojamas worktree
KOPIJOJE, kuri išmetama; pagrindinėje eilėje failas lieka queue; kitas
refill'as jį ima vėl → tas pats lūžis. Sprendimas — kryptis (a): guard'as
elgiasi kaip `ensureFreshCodeIndexForExistingCodeTask` — pirma rebuild, throw
tik kai rebuild'as krito ar nedavė šviežio indekso. Pagrindimas prieš
alternatyvą (b) „bootstrap'as pastato indeksą worktree viduje": (a) turi
precedentą tame pačiame faile, veikia BET KURIAME medyje (ne tik worktree
kelyje), o (b) liestų `worktree-runtime.ts` ir
`composition/loop/command.ts` — pastarasis jau deklaruotas task 115 scope
(lygiagretumo konfliktas); (b) lieka galima vėlesnė optimizacija (žr.
Neįtraukta).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/code-intelligence/query/guard.ts`
- `src/tests/code-intelligence.test.ts` (guard funkcijų testai gyvena čia;
  `assertFreshCodeIndexForGraphAwareTask` iki šiol testų NETURI — Grep
  2026-09-01)

Draudžiama:
- `src/composition/cli/commands-ops.ts` (kvietėjas nekinta — klaidos kelias
  lieka, tik retesnis)
- `src/infrastructure/git/worktrees/worktree-runtime.ts` ir
  `src/composition/loop/command.ts` (kryptis (b) atmesta — 115 scope
  konfliktas)
- `src/application/code-intelligence/indexing/builder.ts` (deterministinis
  builder'is teisingas — tik naudojamas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `guard.ts` (`assertFreshCodeIndexForGraphAwareTask`, 26-31 eil.): kai
  `checkCodeIndexFreshness` ne-ok — bandyti `buildCodeIndex(fs, projectRoot)`
  (importas jau yra, 8 eil.), po jo pakartoti freshness patikrą; klaida
  metama TIK kai rebuild'as išmetė arba indeksas liko nešviežias, su
  priežastimi, įvardijančia abu faktus (kaip 91-122 eil. `blocked` šakos
  tekstai). Sėkmingas rebuild'as — tylus arba su aiškia log eilute per
  kvietėjo kanalą (funkcija log porto neturi — jei pranešimas reikalingas,
  grąžinimo forma sprendžiama nekeičiant kvietėjo, pvz. void lieka).
- Testų lūkestis (`code-intelligence.test.ts`): (1) regresija — graph-aware
  task'as + trūkstamas manifestas + veikiantis šaltinių medis → funkcija
  NEMETA, indeksas pastatytas (tmp katalogo stilius kaip esami šio failo
  testai); (2) rebuild'ui neįmanomam (pvz. neskaitomas medis per fs double)
  → klaida su rebuild priežastimi; (3) ne-graph-aware task'as → indeksas
  neliečiamas (esamas elgesys).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad
worktree viduje `buildCodeIndex` negali pasistatyti dėl kitos aprūpinimo
spragos (pvz. trūksta ne `vq/state`, o dar ko nors) — tada (b) kryptis
grįžta į svarstymą ir jai reikia atskiro task'o dėl 115 konflikto.

## Neįtraukta
- Kryptis (b) — code index aprūpinimas worktree bootstrap'e
  (`worktree-runtime.ts`) kaip optimizacija (rebuild kartą per worktree, ne
  kartą per guard'ą) — atskiras task'as PO 115, jei (a) kaštai pasirodys per
  dideli.
- Worktree vaiko human-review sprendimo pasiekiamumas pagrindiniam medžiui
  (dabar parkavimo sprendimas dingsta su išmetama kopija, o failas lieka
  queue) — ATSKIRAS DEFEKTAS, reikalingas savo task'o su srauto analize;
  čia tik nutraukiamas begalinis ciklas.
- `GRAPH_CONTEXT_REQUEST` heuristikos riba (guard.ts:34): task'as APIE
  `--with-code-graph` flag'ą (pvz. 097) užkabina guard'ą vien dėl frazės
  TEKSTE — žinoma tekstinės heuristikos savybė; po šio task'o ji tampa
  nekenksminga (rebuild vietoj mirties), tad atskiro taisymo nebereikia,
  nebent atsirastų naujas įrodymas.
