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
Jei `src/tests/infrastructure-orphan-reaper.test.ts` „runtime-only untracked
failas..." teste (dabar 63-104 eil.) po leftover įrašymo (80 eil.) yra
patikra su ribotu laukimu, kad failas MATOMAS `git -C <worktree> status`
išvestyje PRIEŠ pirmą `reapOrphanWorktrees` kvietimą — ALREADY_IMPLEMENTED:
cituok laukimo kodą ir (jei buvo) reaper dokumentacijos papildymą kaip
įrodymą.

## Tikslas
Testo flake P2 (2026-09-01, du atsitiktiniai kritimai per dvi pilnų vartų
eigas, po to 3/3 žalias): `infrastructure-orphan-reaper.test.ts` testas
„orphan reap: runtime-only untracked failas nebelieka amžinu KEPT -
preserve+force po lease TTL" (63-104 eil.) tikisi, kad PIRMAS
`reapOrphanWorktrees` kvietimas (83 eil.) grąžins `ORPHAN KEPT` — git
atsisako šalinti dėl ką tik įrašyto untracked `vq/state/leftover.txt`
(80 eil.). Kritimuose vietoj to atėjo `ORPHAN REAPED: path=...
leaseId=lease-spiral` BE `archive=` — grynas reap kelias
(`orphan-worktree-reaper.ts:391`; archive neša tik eskalacijos eilutė, 415),
t. y. `git worktree remove` BE force PRAĖJO (grandinė:
`worktree-reaper.ts:247` → `removeWorktreeDirectory`,
`worktree-removal.ts:107`), nors failas ką tik įrašytas per
`nodeFsAdapter.writeTextFile` (atominis tmp+rename). Diagnostinis zondas,
atkartojęs žingsnius 1:1, praėjo idealiai (KEPT su „contains modified or
untracked files", code 128; po TTL — REAPED su archive=); kontekstas kritimų
metu — lygiagretus loop'as suko build'us worktree'uose (didelė FS apkrova),
kritusio testo trukmė 2.9s vs 10.2s žaliame bėgime. HIPOTEZĖ (nepatvirtinta):
lenktynės tarp atominio rename ir git vidinio status skeno `worktree remove`
viduje Windows'e (galimai AV/indexer įsikišimas). Task'as PIRMIAUSIA
diagnozuoja, tada stabilizuoja: testas dabar remiasi prielaida „git jau mato
failą", kurios pats nesitikrina — determinizavimas yra prielaidos
patikrinimas, ne lūkesčio susilpninimas.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/tests/infrastructure-orphan-reaper.test.ts`
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts` (TIK
  doc-komentaras — žr. Veiksmas 2 lygį; elgesio keitimas = Stop)
- `src/infrastructure/git/worktrees/worktree-reaper.ts` (TIK doc-komentaras,
  ta pačia sąlyga)

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-removal.ts` (remove semantika
  nekeičiama be diagnozės įrodymo — Stop sąlyga)
- `src/infrastructure/fs/node-fs-adapter.ts` (atominis rašymas teisingas —
  ne jo defektas, kol diagnozė neįrodė kitaip)
- `src/domain/git/changes.ts` (`nonRuntimeDirtyEntriesFromStatus` semantika
  nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- DIAGNOZĖ (pirmas žingsnis, išvados į ataskaitą): įvertinti hipotezę pagal
  turimus faktus ir kodo kelią — ar `git worktree remove` be force gali
  praeiti su untracked failu, kurio rename dar nepasiekė git status skeno
  (Windows FS metaduomenų vėlavimas / AV-indexer laikinas lock'as). Jei
  diagnozė atskleistų PRODUKTO defektą (ne testo lenktynes) — Stop.
- 1 LYGIS — testo stabilizavimas: po leftover įrašymo (80 eil.) laukti su
  RIBOTU retry (pvz. iki kelių sekundžių, trumpi intervalai), kol
  `git -C <worktreePath> status --porcelain` išvestyje matomas
  `vq/state/leftover.txt`; tik tada kviesti pirmą reap. Lūkesčiai (KEPT →
  REAPED su archive) NESILPNINAMI — determinizuojama tik prielaida. Riboto
  laukimo timeout'as krenta su aiškia žinute „git per X ms nepamatė ką tik
  įrašyto failo" — jei flake tikroji priežastis kita, testas ją įvardins
  vietoj klaidingo REAPED.
- 2 LYGIS — produkto pusės įvertinimas (dokumentacija, ne elgesys): ar
  grynas reap be archyvo priimtinas runtime-junk-only medžiui —
  `nonRuntimeDirtyEntriesFromStatus` tokį turinį ir taip laiko „ne darbu",
  tad turinio praradimo nėra; jei diagnozė tai patvirtina, užfiksuoti
  reaper doc-komentare (`orphan-worktree-reaper.ts` ir/ar
  `worktree-reaper.ts`), kad lenktynių atveju grynas reap yra nekenksminga
  baigtis runtime-only šiukšlėms. Jei įvertinimas parodytų, kad archyvavimo
  reikia ir gryname kelyje — TAI ELGESIO KEITIMAS: Stop, ne implementacija.
- Testų lūkestis: (1) stabilizuotas testas su status-visibility laukimu —
  KEPT ir REAPED+archive lūkesčiai nepakitę; (2) laukimo helper'is (jei
  iškeltas) deterministiškas ir be begalinio ciklo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei: (1) diagnozė parodytų
produkto defektą (remove be force praleidžia REALIAI matomą untracked failą)
— tai `worktree-removal.ts` elgesio klausimas; (2) 2 lygio įvertinimas
prieitų prie išvados, kad gryname reap kelyje reikia archyvavimo — elgesio
keitimas su savo rizikomis, reikalingas atskiras sprendimas.

## Neįtraukta
- `worktree-removal.ts` remove/fallback semantikos keitimai — tik su Stop ir
  operatoriaus sprendimu.
- Kitų šio testo failo testų stabilizavimas — flake užfiksuotas tik šiame
  teste; jei vykdytojas pastebės tą pačią prielaidą kituose, fiksuoti
  ataskaitoje kaip kandidatą atskiram task'ui.
- Bendro „palauk kol git pamatys" helper'io iškėlimas į testų utils — tik
  jei šio testo stabilizavimas jo natūraliai pareikalaus; masinis kitų testų
  perrašymas ne čia.
