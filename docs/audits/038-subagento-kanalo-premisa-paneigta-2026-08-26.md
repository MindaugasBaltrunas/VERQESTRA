# 038 — Tyrimas: subagento rašymo kanalo prielaida PANEIGTA (2026-08-26)

> Task `038-subagento-rasymai-pasiekia-session-writes-ledgeri.md` savo `## Veiksmas` reikalavo:
> „IŠTIRTI PIRMA: ar PostToolUse hook'as subagento įrankių kvietimams apskritai iškviečiamas.
> … Rezultatas įvardijamas ataskaitoje prieš renkant kelią." Ši ataskaita yra tas rezultatas.
> Tyrimas atliktas tiesiogiai, be delegavimo (operatoriaus sprendimas 2026-08-26).

## Verdiktas

**Iškviečiamas. Subagento `Write`/`Edit` rašymai PASIEKIA `session-writes` ledger'į, Stop hook'as
juos stage'ina, ir jie virsta commit'u.** Spragos, kurią task 038 aprašo, nėra — nei ledger'yje,
nei hook'o registracijoje. Task'as uždaromas kaip **prielaida paneigta**, produkcinio kodo
nekeičiant.

## Lemiamas įrodymas: teigiamas kontrapavyzdys (task 030, 2026-08-26)

| Šaltinis | Įrašas |
|---|---|
| `vq/logs/orchestrator.log:6369` | `[16:46:19] DISPATCH TOOL USAGE: task=030-likusieji-penki-klientai-pereina-i-runtime-patikra … main=Agent,Bash,Grep,ListAgents,Read,ScheduleWakeup agent=Bash,Edit,Glob,Grep,Read` |
| `vq/logs/hooks.log:1864-1909` | `[16:35:21] post-write: …\ui-app\src\model\api.ts` (ir 16:35:27, :32, :42), `[16:36:00] post-write: …\ui-app\src\model\apiEnvelopes.test.ts` (ir 16:36:19, 16:38:03) |
| Bucket | `AG/tasks/done/030-likusieji-penki-klientai-pereina-i-runtime-patikra.md` |

Skaityti taip: `DISPATCH TOOL USAGE` rašomas dispatch'o PABAIGOJE, tad 16:46 eilutė aprašo
~16:34–16:46 bandymą. Pagrindinė sesija tame bandyme nenaudojo **nė vieno** rašymo įrankio
(`main=` sąraše nėra nei `Write`, nei `Edit`); rašė tik subagentas (`agent=…,Edit,…`). Ir vis dėlto
`hooks.log` turi 7 `post-write:` eilutes tiems patiems failams, o task'as baigė `done` su commit'u.

Vienas kontrapavyzdys šiuo atveju pakanka: hipotezė buvo universali („subagento rašymai
nepasiekia ledger'io"), tad vienas bandymas, kuriame jie jį pasiekė, ją paneigia.

## Antrinis patvirtinimas: ankstesnė diagnozė sakė tą patį

`docs/audits/020-session-writes-ledger-diagnosis-2026-08-25.md` — dokumentas, kurį task 038
nurodo kaip savo `## Spec source` — jau buvo tai užfiksavęs:

- įrodymas A: „`vq/logs/hooks.log:2438-2474` — subagento `Edit` rašymai vis dėlto fiksuoti …
  **Hook'ai subagento `Edit` kanale veikia**";
- įrodymas C: „**018-b-03 turėjo `agent=none`** … ir vis tiek `session-writes.json missing` —
  defektas nėra subagentui specifinis";
- santrauka: „`main=Agent` dispatch'ai defektą tik paryškina — jis nėra subagentui specifinis".

Task 038 rėmėsi ta pačia byla, bet iš jos pasiėmė koreliaciją (`main=Agent`), o ne priežastį.
Jo `grep subagent` argumentas („kanalas nepadengtas nei kodu, nei testu") teisingas kaip faktas ir
klaidingas kaip išvada: `Write|Edit` matcher'is įrankio kvietėjo neskiria, tad atskiro „subagent"
kelio ir neturi būti.

## Kas iš tikrųjų atsitiko šešiems human-review task'ams

Tyrimo metu paaiškėjo, kad trys gedimo režimai buvo suplakti į vieną. Nė vienas nėra ledger'io
problema:

### R3 — vykdytojas suprojektavo ir sustojo (3 iš 6)

| Task | `DISPATCH TOOL USAGE` | Baigtis |
|---|---|---|
| `035-siauri-globai…` | `main=Agent,Read,ScheduleWakeup agent=Glob,Grep,Read` | `TASK NOT DONE … clean tree without work evidence` (`orchestrator.log:6094`) |
| `038-subagento-rasymai…` | `main=Agent,Bash,Glob,Grep,Read,ScheduleWakeup agent=Glob,Grep,Read` | ta pati eilutė (`:6353`) |
| `031-kompiliuoto-kuno-preambule…` | `main=Agent,ScheduleWakeup agent=Glob,Grep,Read` | ta pati eilutė (`:6515`) |

Visuose trijuose **nė vienas dalyvis nenaudojo rašymo įrankio** — nei pagrindinė sesija, nei
subagentas. Grandinė nuėjo iki `architect` (projektavimas), gavo analizę ir baigėsi
`ScheduleWakeup`'u. `ROLLBACK TASK-SCOPED: restored 0 task path(s)` visais trim atvejais — nes
atkurti nebuvo ko: darbo niekada nebuvo.

Svarbu: **vartai suveikė teisingai.** Vietinė diagnozė grąžino `verdict=done reason=checks passed`,
bet išorinė patikra „švarus medis be darbo įrodymo" tą verdiktą perrašė ir nuleido task'ą į
human-review. Tai fail-closed elgesys, ne regresija. Klaidą padarė vykdytojas, ne mechanizmas.

### R4 — splitter'io išgalvotas spec šaltinis (2 iš 6)

`orchestrator.log:6264` ir `:6270`:

```text
CLAUDE PREFLIGHT: task=037-a-02-… human-review reason: Invalid OpenSpec reference:
openspec/changes/auto-037-task-numeris-vienareiksmis-per-visa-gyvavimo-c does not exist
```

Abu `037-*` vaikai niekada nebuvo dispatch'inti — juos atmetė preflight'as (`preflight_failed=1`).

Tiksli priežastis nustatyta ir ji NĖRA „generatorius išgalvojo neegzistuojantį kelią". Change'as
egzistuoja — jis perkeltas:

```text
AG/openspec/changes/archive/auto-037-task-numeris-vienareiksmis-per-visa-gyvavimo-c   ← YRA
AG/openspec/changes/auto-037-task-numeris-vienareiksmis-per-visa-gyvavimo-c           ← NĖRA
```

Seka: `slugFromTask` (`application/task-planning/openspec-slug.ts:21-33`) tėvui 037 sukūrė
auto-change'ą; skaidymas vaikams įrašė tą patį slug'ą į `## Spec source`; tėvas baigė `done`;
`task-execution/openspec-archive.ts` tą patį slug'ą rekonstravo ir change'ą **suarchyvavo**;
po to vaikų preflight'as jo nebeberado. Vaikai tapo nedispatch'inami dėl sistemos pačios
tvarkymosi veiksmo.

**Sprendimas „preflight'as tepriima ir archyvą" NETINKA.** Archyvinės nuorodos atmetimas yra
sąmoninga, testu užrakinta taisyklė: `src/tests/interfaces-cli-preflight.test.ts:315-319`
tikrina, kad `openspec/changes/archive/senas` grąžina `Invalid OpenSpec reference: … archived`.
Jos silpninimas būtų testo, o ne klaidos, taisymas.

Tikroji šaknis yra tvarkos: **change'as paskelbiamas baigtu, kol jo darbas nebaigtas.** Vaikai yra
to paties change'o tęsinys, tad archyvavimas turi arba palaukti, kol nė vienas eilės / human-review
task'as jo nebecituoja, arba skaidymas turi vaikams duoti tą patį spec šaltinį, kurį citavo tėvas
(pvz. `openspec/changes/verqestra-backlog-v1`), o ne tėvo auto-change'ą. Tai sprendimas apie
archyvavimo semantiką, todėl paliekamas operatoriui, o ne pataisomas tyliai.

### R5 — sugadintas sprendimo JSON (1 iš 6)

`orchestrator.log:6524`: `TASK HUMAN REVIEW: 032-shadow-matuoja-prompta-kuri-worker-realiai-gauna
corrupted_decision_json=1`. Atskiras kanalas, su ledger'iu nesusijęs.

## Ką daryti su task 038

Rekomendacija: **uždaryti be įgyvendinimo.** Jo `## Veiksmas` numatė šitą šaką („Jei ne — spraga
yra … ir sprendimas kitoks"); realybė pasirodė esanti trečia galimybė, kurios task'as nenumatė —
spragos nėra iš viso. Įgyvendinti jį reikštų pridėti mechanizmą neegzistuojančiam kanalui ir
antrą kelią į ledger'į, kurio pats task'as `## Stop` sekcijoje bijojo.

Papildoma pastaba: 038 `## Patikra` reikalauja `pnpm test`, o jo `## Veiksmas` remiasi žurnalų
eilutėmis, kurių `vq/logs/hooks.log` nebeturi — failas nuo tos diagnozės buvo perstatytas
(dabar 2094 eilutės, o diagnozė cituoja 2438-2474). Žurnalais grįsti task'ai turi būti vykdomi,
kol įrodymas dar gyvas, arba cituoti jį verbatim į task'o kūną.

## Kas lieka atvira (NE šio tyrimo dalis)

- **R2 iš 020 diagnozės** — Stop hook'o commit'as nespėja iki dispatch'o pabaigos, ir task-scoped
  rollback'as sunaikina ledger'yje matomą, dar necommit'intą darbą. 020 diagnozė jį paliko
  atvirą; šis tyrimas jo nelietė ir jo nepakartojo.
- **R3 vykdytojo sutartis** — ar dispatch'as turi teisę baigtis be nė vieno rašymo įrankio, kai
  task'as deklaruoja `## Failai / Leidžiama`. Šiuo metu tai tyliai kartojasi ir kainuoja pilną
  dispatch'ą (3 iš paskutinių 6).
- **R4 archyvavimo tvarka** — tėvo auto-change'as archyvuojamas, kol jo vaikai dar eilėje; du
  sprendimo keliai aprašyti R4 skyriuje, abu keičia semantiką, tad reikalauja operatoriaus.
- **R5 sprendimo JSON sugadinimas** — priežastis netirta.

## Ko šis tyrimas NEDARO

- Nekeičia jokio produkcinio kodo. Vienintelis šios sesijos rašymas — šis `.md`.
- Neperkelia ir nekeičia nė vieno task'o failo: `038` lieka `AG/tasks/human-review/`, kad
  ledger'io fingerprint'as nepradėtų driftuoti. Bucket'o keitimas — operatoriaus sprendimas.
- Netaiso R2–R5. Jie įvardyti, kad nebūtų prarasti, bet kiekvienas yra atskiras task'as.
