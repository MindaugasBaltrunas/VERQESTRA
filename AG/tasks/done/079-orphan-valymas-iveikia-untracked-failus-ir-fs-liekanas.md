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

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 GeoGravity w1/w2 audito TOP-2 — branch-blocked mirties spiralė: 139 ORPHAN KEPT, 92 katalogai/1.72 GB, 6 × LOOP STOP all-blocked (P0)

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 073-registraciju-valymas-visuose-worktree-salinimo-keliuose
- 074-neintegruoto-w2-darbo-apsauga-po-proceso-luzio

## Žingsnis 0 — ar jau įgyvendinta?
Jei orphan reaper'is: (a) worktree su untracked/modified failais moka
pašalinti PO turinio išsaugojimo (archyvas/patch) vietoj amžino
`ORPHAN KEPT`; (b) mato ir valo `.ag/worktrees` KATALOGUS be git
registracijos; (c) `ORPHAN REAP TRUNCATED` likutį garantuotai paima kitą
praėjimą — ALREADY_IMPLEMENTED su eilučių įrodymu.

## Tikslas
GeoGravity mirties spiralė (log auditas 2026-08-29): worker'is palieka
untracked failus → `git worktree remove` be `--force` grąžina 128 →
`ORPHAN KEPT: reason=check-failed` (**139 kartų**) → registracija lieka →
kitas bandymas ima vardą `-a11/-a12/-a13` (**48 % registracijų su
kolizijos priesaga**) → likusios šakos generuoja `branch-blocked=1…40`
(visi 134 `task_failed`!) → `LOOP STOP: all-blocked` (**6 kartai**).
Papildomai: **40 katalogų be jokios registracijos** (1.05+ GB) yra amžini —
`findOrphanWorktrees` iteruoja tik git registracijas, failų sistemos
lygio GC nėra; `ORPHAN_WORKTREE_REAP_LIMIT=20` nukirpo 2 šakas, kurių
kitas praėjimas nebepaėmė (gyvos iki šiol).

Taisymas (trys dalys tame pačiame reaper kelyje):

1. **check-failed → preserve+force**: kai `git worktree remove` krenta dėl
   untracked/modified, reaper'is turinį išsaugo (esamas `.patch` archyvo
   mechanizmas, o su 074 sargu — ir preserved ref neintegruotiems
   commit'ams) ir tada šalina su `--force`. `ORPHAN KEPT` lieka tik
   atvejams, kur išsaugoti nepavyko — su aiškia priežastimi.
2. **FS-lygio GC**: po registracijų praėjimo skenuojami
   `.ag/worktrees/<run_id>/*` katalogai, kurių nėra `git worktree list` —
   senesnis nei 1 h katalogas šalinamas su log eilute
   `ORPHAN DIR REMOVED: <kelias> (no registration)`. Tuščias run_id
   katalogas šalinamas kartu.
3. **Truncation carry-over**: limitas lieka, bet nukirpti kandidatai
   įsimenami (state failas) ir kitą praėjimą imami PIRMI — jokia šaka
   negali likti už limito amžinai.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts`
- `src/infrastructure/git/worktrees/worktree-reaper.ts`
- `src/infrastructure/git/worktrees/worktree-removal.ts`
- `src/tests/infrastructure-orphan-reaper.test.ts` (numatomas; jei testas
  gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)
- `src/tests/infrastructure-worktrees.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-branch-integration.ts`
  (merge logika neliečiama)
- `src/application/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: preserve+force tvarka suderinama su 074 eskalacijos sargu
  (neintegruoti commit'ai → preserved ref PRIEŠ bet kokį force); FS-GC
  amžiaus riba ir saugikliai (niekada nešalinti katalogo, kurį
  `git worktree list` mato).
- Tester: (a) worktree su untracked → išsaugota + pašalinta, registracija
  išvalyta, vardas be `-a11` kolizijos kitam bandymui; (b) katalogas be
  registracijos, >1 h → pašalintas; su registracija → nepaliestas;
  (c) truncation: 22 kandidatai, limitas 20 → likę 2 paimami kito
  praėjimo pradžioje.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei preserve+force
tvarka konfliktuotų su 074 sprendimu.

## Neįtraukta
Bootstrap spragos (078). Esamų GeoGravity liekanų rankinis valymas
(operatoriaus sąrašas ataskaitoje). `.claude/worktrees` (ne AG namespace).
