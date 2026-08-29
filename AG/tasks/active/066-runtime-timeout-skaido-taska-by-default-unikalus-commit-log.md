# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 operatoriaus pavedimu („šis skaidymas turi būti verqestra logikoje by default, kaskart kai task per didelis") — GeoGravity 1178 timeout'ino 3 kartus iš eilės be jokio skaidymo

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei (a) pakartotinis dispatch timeout (exit 124) route'ina taską į
`buildTaskSplitPlan` vietoj dar vieno retry/human_review IR (b) splitter'io
vaikai gauna UNIKALŲ commit-msg kelią (`logs/tasks/<child-stem>-commit-msg.md`)
vietoj tėvo `## Stop` kopijos — ALREADY_IMPLEMENTED.

## Tikslas
GeoGravity 2026-08-28/29: task 1178 timeout'ino (exit 124) TRIS kartus —
16:23, ~21:00 ir 07:12 — kiekvieną kartą sudegindamas iki 100 min opus
laiko, ir nė karto nebuvo suskaidytas. Skaidymo logika egzistuoja
(`task-splitting.ts`), bet `shouldSplitTask` matuoja tik STATINĮ teksto
dydį preflight'e; 1178 tekstas telpa į ribas („size within limits"), o jo
tikrasis dydis pagal DARBĄ matomas tik runtime — ir tas signalas į
skaidymą negrįžta.

Antra spraga tame pačiame faile: `renderTaskPart` kopijuoja tėvo `## Stop`
sekciją (su tėvo commit-msg keliu) į kiekvieną vaiką — todėl visi vienos
šeimos subtaskai dalinasi vienu `logs/tasks/<parent>-commit-msg.md` ir jų
write set'ai kertasi (GeoGravity 1150-a/b/c atvejis: w2 lygiagretumas
užblokuotas paties splitter'io sugeneruotais konfliktais).

Reikalavimai:

1. **Runtime-oversize trigeris (by default):** kai diagnozė mato dispatch
   exit 124 (timeout) su pasikartojančiu parašu (>=2 bandymai; ta pati
   retry-signature mechanika, kuri dabar veda į human_review), vietoj
   trečio bandymo arba parko kviečiamas `buildTaskSplitPlan` — tėvas
   žymimas superseded, vaikai dedami į queue, žurnale aiški eilutė
   `TASK SPLIT (runtime-oversize): parent=<id> parts=<n> po <k> timeout`.
   Human_review lieka fallback'u tik kai skaidyti neįmanoma (1 veiksmas,
   1 kelias — nedalomas).
2. **Unikalus commit_log kiekvienam vaikui:** `renderTaskPart` generuoja
   vaiko `## Stop` su `logs/tasks/<child-stem>-commit-msg.md` ir tą patį
   kelią įrašo į vaiko allowlist (schema v2 header'yje — `commit_log`
   lauką). Tėvo Stop tekstas išsaugomas, keičiasi tik kelias.
3. Split'inant iš runtime signalo, vaikų `## Veiksmas` dalinamas kaip
   dabar (chunk pagal limits) — jokio LLM kvietimo, deterministinis kelias.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/task-splitting.ts`
- `src/application/task-execution/run-coordinator.ts` (diagnozės->split
  maršrutas; jei jis gyvena kitame task-execution faile — tas failas
  vietoje šio, įrašyti į ataskaitą)
- `src/application/task-execution/run-coordinator-terminal.ts`
- `src/domain/diagnosis/dispositions.ts` (jei verdiktų aibė pildosi 'split')
- `src/domain/tasks/sections.ts` (TIK jei commit_log header laukui reikia
  schema v2 skaitytojo; kitu atveju neliesti)
- `src/tests/task-execution-orchestration.test.ts`
- `src/tests/task-execution-rules.test.ts`
- `src/tests/characterization-diagnosis.test.ts`
- `src/tests/task-execution-runtime-split.test.ts` (numatomas naujas)

Draudžiama:
- `src/interfaces/**` (išskyrus žurnalo eilutę, jei ji ten gimsta — tada
  konkretų failą įrašyti į ataskaitą kaip nukrypimą)
- `dist/**`
- `node_modules/**`
- `ui-app/**`

> Scope sukonkretintas 2026-08-29 (buvo katalogų wildcard'ai — jie kirstųsi
> su visų kitų queue task'ų testais ir atimtų w1/w2 lygiagretumą).

## Veiksmas
- Architect: nustatyti, kur gyvena „repeated error signature" sprendimas
  (diagnozės dispositions) ir kaip švariai įterpti 'split' maršrutą prieš
  human_review; kur preflight splitter'io planas paverčiamas failais —
  perpanaudoti tą patį kelią.
- Coder: (1) runtime trigeris, (2) renderTaskPart unikalus commit_log +
  allowlist įrašas, (3) superseded tėvo žymėjimas.
- Testai: timeout×2 → split (vaikai queue, tėvas superseded); timeout×1 →
  repair kaip dabar; nedalomas taskas → human_review; vaikų commit_log
  keliai unikalūs ir įtraukti į allowlist; esami statinio skaidymo testai
  nepakitę.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
LLM-pagrįstas „protingas" skaidymas pagal sesijos progresą (preserved
darbo hint'ai) — atskiras žingsnis po 063. Token biudžetų kėlimas.
Istorinių jau suskaidytų taskų taisymas (GeoGravity 1150 pamoka
užfiksuota atmintyje).
