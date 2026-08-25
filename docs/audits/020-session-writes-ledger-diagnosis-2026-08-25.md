# 020 — Diagnozė: session-writes ledger'is ir prarandamas dispatch darbas (2026-08-25)

> PROVENIENCIJA: šį dokumentą parašė 020 task'o vykdytojas (loop dispatch'as). Jis buvo
> nuklydęs į `AG/tasks/` bucket'ą kaip `020-diagnosis.md`, kur preflight'as jį teisingai atmetė
> kaip ne-task'ą (`preflight_failed=1`); perkeltas čia 2026-08-25, turinys nekeistas.
> R1 kryptis įgyvendinta tą pačią dieną (020-a-02: `session-stage-planning.ts`
> `resolveAllowedPathsFallback` + `STAGING LEDGER FALLBACK` žyma + 5 regresiniai testai);
> R2 užfiksuotas kaip task 021.

## Santrauka

`vq/state/session-writes.json` yra **įrankio kilmės** ledger'is, ne darbo ledger'is: jį pildo tik
`PostToolUse` `Write|Edit` kanalas per `hookPostWrite`. Bet koks kitas rašymo kanalas — `Bash`,
`PowerShell` ar bet kuris iš jų paleistas procesas — palieka sesijos darbą **nematomą** Stop
hook'ui, nes `hookPostBash` į ledger'į nerašo nieko. Kadangi Stop hook'as stage'ina tik ledger'io
aibę (`git add --all` niekada nevykdomas), nematomas darbas į commit'ą nepatenka. Du esami
saugikliai (clean-baseline rescue ir `resolveLedgerGap`) dengia spragą tik dalinai ir kaip tik
ilgesniuose, daugiaetapiuose bandymuose išsijungia. `main=Agent` dispatch'ai defektą tik paryškina
— jis nėra subagentui specifinis (žr. įrodymą C: 018-b-03 turėjo `agent=none`).

**Tikslinimas po reviewer patikros (privalomas skaitant žemiau esančius įrodymus).** Žurnalai rodo
ne vieną, o **du skirtingus** gedimo režimus, ir jie turi priešingą santykį su ledger'iu:

- **R1 — ledger'is aklas** (įrodymas B, `comparison.ts`): failas pakeistas ne `Write|Edit` kanalu,
  ledger'yje jo NĖRA. Toks darbas iš commit'o iškrenta, bet task-scoped rollback'as jo **neliečia**
  (rollback restorina tik ledger'io kelius), tad jis lieka purvinas medyje ir gali būti pagautas
  vėliau — būtent taip `comparison.ts` ir išgyveno.
- **R2 — commit'as nespėja** (įrodymas A): ledger'yje darbas **buvo**, bet Stop hook'o commit'as
  neįvyko iki dispatch'o pabaigos, ir tada task-scoped rollback'as, kuris kelius ima **iš to paties
  ledger'io**, tiksliai tą darbą ir sunaikino. Čia ledger'is veikė; nesuveikė seka.

Ši diagnozė ir pasirinkta kryptis adresuoja **R1**. R2 lieka neuždarytas (žr. „Ko ši diagnozė
NEDARO"): jam Stop hook'o fallback'as nepadėtų, nes plane trūkstamų kelių ten nebuvo.

## Šaknies priežastis

Ledger'io semantika susieta su įrankio tapatybe, o ne su darbo faktu:

- `src/interfaces/hooks/post-write.ts:hookPostWrite` (eil. 248-291) — **vienintelė** vieta,
  kviečianti `recordSessionWrite` (eil. 264 → 273) → `appendSessionWrite` (to paties failo eil. 49)
  → `session-writes.json`. Pasiekiama tik per `Write|Edit` matcher'į.
- `src/interfaces/hooks/post-hooks.ts:81-88` `hookPostBash` — rašo `post-bash:` žurnalo eilutę ir
  `bash-digest-shadow.jsonl` shadow telemetriją; į `session-writes.json` **nerašo nieko**.
- `templates/.claude/settings.json` — `PostToolUse` matcher'iai: `Read` → `hook-post-read`,
  `Write|Edit` → `hook-post-write`, `Bash|PowerShell` → `hook-post-bash` (visi `"async": true`);
  `PreToolUse`: `Bash|PowerShell` → `hook-pre-bash`, `Write|Edit` → `hook-pre-write`.

Rašymo mechanika žemiau to lygio **sveika**:
`src/interfaces/hooks/session-write-ledger.ts:appendJsonArrayEntry` yra atominis, po lock'u, su
„drop" politika, o gedimas virstų garsia `ledger_append_failed=1` eilute. Žurnale nėra **nė vienos**
tokios eilutės — vadinasi, įrašai ne pralaimimi, o iš viso negimsta.

**Antrinė sąlyga, dėl kurios spraga virsta žala.** `src/application/task-execution/session-stage-planning.ts`
turi du saugiklius, ir abu išjungiami galiojančio savo baseline'o arba purvino medžio:

- clean-baseline rescue (`plan.ledgerMisses`, eil. 68-87) — veikia tik kai `baselineClean === true`;
- `resolveLedgerGap` (eil. 111-118) — `attemptStartKnown = ownBaseline && baseline_valid === true`,
  ir `if (!input.dispatchNonce.trim() || attemptStartKnown) return []` — t. y. saugiklis veikia tik
  kai savo sesijos baseline'o **nebėra**.

Todėl būtent ilgesniame, daugiaetapiame bandyme (medis jau purvinas, savas baseline galioja)
nesuveikia nė vienas saugiklis — o kaip tik ten prarandama daugiausia darbo.

## Įrodymai

### A. 018 — darbas sunaikintas (režimas R2, NE ledger'io aklumas)

- `vq/logs/orchestrator.log:1651` — `[13:57:18] DISPATCH TOOL USAGE:
  task=018-benchmark-nepriskirti-taskai-negali-tyliai-dingti ... main=Agent,ScheduleWakeup
  agent=Bash,Edit,Glob,Grep,Read`. Pagrindinė sesija nenaudojo **nė vieno** rašymo įrankio; visas
  darbas subagente.
- `vq/logs/hooks.log:2438-2474` — subagento `Edit` rašymai vis dėlto fiksuoti:
  `post-write: ...capture-baseline.ts` (13:55:31, :40, :45, :50) ir `...baseline-report.ts`
  (13:56:24, :30, 13:57:07). Hook'ai subagento `Edit` kanale **veikia**, ir šie 7 įrašai reiškia,
  kad abu produkto failai ledger'yje **buvo**.
- `vq/logs/hooks.log:2480-2484` — `[13:57:42] STOP įvykis`, po jo tik guard'ų eilutės (13:57:45) ir
  tyla: jokio „STOP leidžiamas", jokio „Git add", jokio commit'o. Kitas `STOP įvykis` — tik 13:59:39.
  `hookOnStop` kiekvienoje pabaigos šakoje rašo eilutę (`on-stop.ts:232-316`), tad **jokios** eilutės
  nebuvimas reiškia, kad ta Stop vykdymo eiga iki staging'o kodo nepriėjo, o ne kad planas buvo
  tuščias. Orkestratorius `CLAUDE FINISHED` užfiksavo dar 13:57:18 — 24 s PRIEŠ šį Stop įvykį.
  (Prielaida, kurios žurnalas neįrodo: kad būtent ši `STOP` eilutė priklauso dispatch'o, o ne
  lygiagrečiai repo sesijai — `hooks.log` sesijų neskiria.)
- `vq/logs/orchestrator.log:1713-1716` — `[13:59:20] CLAUDE DIAGNOSIS (local): verdict=done
  reason=checks passed and changed files are inside allowed paths`; `[13:59:29] ROLLBACK
  TASK-SCOPED: restored 2 task path(s)`; `[13:59:29] TASK NOT DONE: ... Claude did not create a new
  commit`.
- `git log --oneline -- src/application/benchmark/capture-baseline.ts
  src/application/benchmark/baseline-report.ts` → naujausias commit'as yra senas `c5b8c3e`. 018
  darbo repo istorijoje **nėra**: darbas sunaikintas. (Komanda paleista 15:09,
  `hooks.log:3089-3091`; reviewer sesijoje `git` blokuotas allowlist'o, tad hash'as neperverifikuotas
  — laikyti provenance'u, ne pakartotinai patikrintu faktu.)
- **Kas būtent sunaikino.** `ROLLBACK TASK-SCOPED` kelius ima iš ledger'io:
  `rollback-stable.ts:220` → `rollback-scope.ts:130-147:readTaskScopePaths` →
  `session-write-owners.ts:132:taskScopeRestorePaths(sessionWrites, owners, identity)`. Skaičius
  „restored 2 task path(s)" todėl yra **tiesioginis įrodymas, kad tuo momentu ledger'yje gulėjo
  lygiai tie 2 nuosavi produkto keliai**. Vadinasi 018 atveju ledger'is NEBUVO aklas — nesuveikė
  tai, kad commit'as neįvyko prieš rollback'ą, o rollback'as ledger'io matomą, dar necommit'intą
  darbą revertina turinio lygiu.
- Tai atitinka šios užduoties spec source formuluotę („Stop hook commit'as nespėja iki dispatch
  pabaigos"), o ne subagento matomumo hipotezę. Įrodymas A todėl **nepagrindžia** pasirinktos
  krypties; ją pagrindžia tik įrodymas B.

### B. 018-a-02 — išgelbėta tik atsitiktinai (režimas R1: TIKRAS ledger'io aklumas)

- `vq/logs/orchestrator.log:1734` — `[14:12:42] task=018-a-02-... main=Agent,Read,ScheduleWakeup
  agent=Bash,Edit,Glob,Grep,Read`.
- `src/domain/metrics/comparison.ts` buvo realiai pakeistas (14:09:40 jis pateko į commit'ą,
  `hooks.log:2597,2600`), bet `vq/logs/hooks.log` jam neturi **nei** `rašymas leidžiamas`
  (PreToolUse), **nei** `post-write:` eilutės. `grep -n "comparison.ts" vq/logs/hooks.log` grąžina
  1124, 1126, 1234-1237, 2493, 2502, 2510, 2540-2543, 2548, 2560, 2561, 2568, 2569, 2596, 2597,
  2600, 2628, 2945, 2946, 2965, 2966, 2970, 2971. Iš jų nė viena nėra rašymo įvykis: tai `bash:` /
  `post-bash:` / `post-read:` eilutės plius Stop hook'o pėdsakas (2596 `SESSION LEDGER MISS`, 2597
  commit žinutė, 2600 `git commit`) ir 2628/2970/2971 `BLOCKED bash`. Tai patikrinamas
  **neigimo** įrodymas: nulis `post-write:` eilučių šiam keliui per visą žurnalą.
- `vq/logs/hooks.log:2596` — `[14:09:40] SESSION LEDGER MISS — švarus baseline
  (task=018-a-02-...), stage'inami ledger'yje TRŪKSTANTYS produkto failai:
  src/domain/metrics/comparison.ts`.

Išvada: failas pateko į commit'ą **tik** per clean-baseline rescue heuristiką, ne per ledger'į. Tas
pats darbas ant purvino medžio būtų dingęs kaip A atveju.

### C. 015 — tas pats defektas, kita žala (matomumas)

- `vq/logs/orchestrator.log:1958` — `[14:46:00] WARNING: session-writes.json missing
  task=015-b-03-... — skipping out-of-scope attribution (safe fallback, no false human_review)`.
- Tos sesijos įrankių pjūvis: `orchestrator.log:1896` — `main=Agent,Bash,Grep,Read agent=Grep,Read`:
  nė vieno `Write`/`Edit` → `hook-post-write` nė karto nepaleistas → ledger'io failas apskritai
  nesukurtas.
- Tas pats pasikartoja: `orchestrator.log:2042` (018-b-03; to dispatch'o įrankių pjūvis
  `main=Bash,Glob,Grep,Read agent=none` yra atskiroje eilutėje `:1980`), `:1090` (013), `:1458`
  (007), `:1625` (015). Visos penkios yra identiška `WARNING: session-writes.json missing` eilutė.
- Kodas: `src/interfaces/cli/dispatch/claude-diagnose/diagnose-evidence.ts:86-90` — kai
  `!ledger.present`, out-of-scope attribution **tyliai** praleidžiama (tik WARNING eilutė žurnale,
  be lauko rezultate).

Įrodymas C yra lemiamas krypčiai: **018-b-03 turėjo `agent=none`** (`orchestrator.log:1980`) ir vis
tiek `session-writes.json missing` — defektas nėra subagentui specifinis.

## Grandinės pjūvis

Kur tiksliai prarandamas įvykis:

```text
Write|Edit  → hook-post-write → post-write.ts:hookPostWrite (248) → recordSessionWrite (273)
              → post-write.ts:appendSessionWrite (49)
              → session-write-ledger.ts:appendJsonArrayEntry (90) → session-writes.json   [VEIKIA]

Bash|PowerShell → hook-post-bash → post-hooks.ts:hookPostBash (81-88)
                  → log("post-bash: ...") + bash-digest-shadow.jsonl              [ĮVYKIS PRARANDAMAS]

Stop        → on-stop.ts:hookOnStop → on-stop-context.ts:resolveStagePlan (135-161)
              → application/task-execution/session-stage-planning.ts:planSessionStaging
              → stage'inama TIK session-writes.json aibė (filtruota nuosavybe) + lifecycle keliai
              → `git add --all` NIEKADA                                            [ŽALA MATERIALIZUOJASI]
```

Ledger'is turi ir daugiau vartotojų, ne vien Stop staging'ą — kiekvienas jų paveldi tą pačią
įrankio kilmės prielaidą: `src/infrastructure/git/rollback-scope.ts:135` (task-scoped rollback),
`src/interfaces/hooks/package-guard.ts:171`, `src/composition/quality/diagnose-adapters.ts:139`.
Rollback'o vartotojas yra svarbiausias: jis ledger'į naudoja **revertinimui**, tad ledger'io įrašas
be commit'o reiškia ne apsaugotą, o pasmerktą darbą (įrodymas A).

`src/interfaces/hooks/stop-guards.ts` ledger'io neliečia — tai tik blokuojantys pre-commit
guard'ai, ne šio defekto dalis.

## Pasirinkta kryptis

**„Stop hook siaurinantis fallback"** — Stop hook'as gali stage'inti ledger'yje nesančius kelius,
bet tik kai **visos** sąlygos galioja vienu metu:

1. sesija yra dispatch'inta (`AG_DISPATCH_NONCE` netuščias) — interaktyvioje sesijoje fallback'as
   išjungtas;
2. planas neturi **nė vieno** produkto kelio (tik lifecycle) **arba** `git status` turi produkto
   kelių, kurių plane nėra;
3. **visi** ne-runtime purvini `git status` keliai telpa į aktyvaus task'o `## Failai / Leidžiama`
   aibę;
4. joks kandidatas nėra įrodytai svetimas (`owners` sidecar'o `foreign`) ir nėra task'o aktyvacijos
   baseline'o purve.

Sąlyga 3 yra griežtai siaurinanti: **vienas** kelias už allowed paths ribų išjungia fallback'ą
visiškai, o ne dalinai. Kiekvienas suveikimas palieka **garsią, grep'inamą** žymą žurnale (pvz.
`STAGING LEDGER FALLBACK: task=<id> +N files: ...`) — fallback'as niekada nebūna tylus.

**Ką ši kryptis uždaro ir ko ne.** Ji uždaro **R1** (įrodymas B: rašymas ne per `Write|Edit`, kelio
ledger'yje nėra) ir tik tada, kai Stop hook'as apskritai pasiekia staging'o kodą. Ji **neuždaro
R2** (įrodymas A): ten planas trūkstamų kelių neturėjo — ledger'yje kelias buvo, o Stop eiga iki
staging'o nepriėjo. Todėl 020-a-02 regresinis testas įrodys R1 elgseną, bet 018 scenarijaus
istorijos savaime neatkurs; R2 lieka atviras punktas apačioje.

## Atmestos kryptys

**„Ledger nepriklausomas nuo įrankio kilmės".** Principe teisinga — tai tikroji šaknis. Atmesta dėl
dviejų priežasčių. Pirma: realus įgyvendinimas reikalauja naujo `PostToolUse` matcher'io / hook'o
registracijos `templates/.claude/settings.json`, o tai yra aiški **operatoriaus patvirtinimo riba**
šiai užduočiai. Antra: iš `Bash` payload'o (komandos eilutės) neįmanoma patikimai išvesti, kuriuos
failus komanda pakeitė — vienintelis patikimas šaltinis vis tiek yra `git status`, t. y. tas pats
mechanizmas, kurį naudoja pasirinkta kryptis, tik brangesnėje vietoje (po **kiekvieno** Bash
kvietimo).

**„Agent draudimas dispatch sandbox'e".** Gydo koreliaciją, ne priežastį. Įrodymas C (018-b-03:
`agent=none`, ledger'io nėra) rodo, kad defektas pasireiškia ir be subagentų. Be to, `Agent`/`Task`
nėra `DISPATCH_BASELINE_TOOLS` grindyse (`src/infrastructure/adapters/claude-tool-schema.ts:44-54`),
tad draudimas atimtų realiai naudojamą pajėgumą negrąžindamas nė vieno prarasto rašymo.

## Įgyvendinimo apimtis

Failai, kuriuos lies 020-a-02:

- `src/application/task-execution/session-stage-planning.ts` — **gryna** taisyklė (ar visi purvini
  keliai telpa į allowed paths; kandidatų atranka). Čia jau gyvena `resolveLedgerGap` (eil.
  111-118), tad taisyklė turi būti **šalia jo**, o ne dubliuota.
- `src/interfaces/hooks/on-stop-context.ts` — IO: allowed paths įvedimas į `planSessionStaging`
  įvestį (skaitomas `vq/state/current-task-file` — realus state failas, rašomas
  `src/infrastructure/state/task-state-store.ts:269`; parse'inama esamu parseriu
  `src/application/context-pack/assemble/parse-task.ts:20`, kuris allowed paths ima iš
  `src/domain/tasks/index.ts:allowedPaths`). Nei `parse-task.ts`, nei `domain/tasks` **nekeičiami**
  — tik importuojami, tad į 020-a-02 „Leidžiama" sąrašą jiems patekti nereikia (ir `src/domain/**`
  ten yra draudžiamas — importuoti tai netrukdo).
- `src/interfaces/hooks/on-stop.ts` — garsi žyma `logStagingEvidence` funkcijoje (eil. 173-189,
  šalia esamų `SESSION LEDGER MISS` ir `STAGING LEDGER GAP` eilučių).

Nekeičiama: `templates/.claude/settings.json`, `src/interfaces/hooks/session-write-ledger.ts`
(ledger'io rašymo mechanika sveika), `src/interfaces/hooks/stop-guards.ts`.

Testai:

- `src/tests/application-session-stage-planning.test.ts` — 018 regresijos scenarijus:
  `dispatchNonce` yra, `sessionWrites` tuščias, `statusOutput` turi 2 produkto kelius, kurie telpa į
  allowed paths → abu patenka į `paths` ir pažymimi kaip fallback. Neigiamas atvejis: vienas kelias
  **už** allowed paths → fallback'as neįsijungia visai (siaurinantis, ne dalinis).
- `src/tests/interfaces-hooks-on-stop.test.ts` — garsios žurnalo žymos įrodymas.

**Svarbi pastaba 020-a-02 užduočiai.** Jos dabartinis „Failai / Leidžiama" sąrašas yra
`post-write.ts`, `session-write-ledger.ts`, `on-stop.ts`, `stop-guards.ts` plius trys
`interfaces-hooks-*` testai. Jame **nėra dviejų realiai keistinų failų**:
`src/application/task-execution/session-stage-planning.ts` ir
`src/interfaces/hooks/on-stop-context.ts`; taip pat nėra testo
`src/tests/application-session-stage-planning.test.ts`. Arba sąrašas praplečiamas šiais trimis,
arba gryna taisyklė būtų priversta gyventi `interfaces` sluoksnyje — tai pažeistų esamą
architektūrą: sprendimas „kieno darbas patenka į commit'ą" pagal `session-stage-planning.ts`
antraštę privalo likti grynas ir `application` sluoksnyje. Atvirkščiai: du šiuo metu leidžiami
failai (`session-write-ledger.ts`, `stop-guards.ts`) pagal šią diagnozę **neturėtų būti liečiami**.

## Ko ši diagnozė NEDARO

- Nekeičia jokio produkto kodo. Vienintelis šios sesijos rašymas — šis `.md`.
- Neliečia `templates/.claude/settings.json`. Pastaba: `src/domain/policies/write-policy.ts:210`
  turi prie šaknies prisegtą `/^templates\//` carve-out, tad hook'as šio failo **neblokuotų** —
  ribą laiko tik užduoties scope, todėl ji laikoma sąmoningai.
- Nesprendžia 015 matomumo dalies (`diagnose-evidence.ts:86-90` tyli, kai `!ledger.present`) — tai
  atskiras 020-b-03 darbas. Pastaba tam task'ui: jo „Leidžiama" sąrašas šiuo metu yra
  `src/domain/git/changes.ts` + jo testas, o tyli praleidimo eilutė gyvena
  `src/interfaces/cli/dispatch/claude-diagnose/diagnose-evidence.ts` — sąrašas ir taikinys
  nesutampa.
- **Neuždaro R2** (įrodymas A): kad Stop hook'o commit'as nespėja iki dispatch pabaigos, o
  task-scoped rollback po to revertina būtent ledger'yje matomą necommit'intą darbą
  (`rollback-scope.ts:130-147`). Tai atskiras, dar nesuformuluotas task'as; jo be R1 sprendimo
  nepakeičia ir jis nepakeičia R1.
- Nesprendžia dėl `hook-post-bash` praplėtimo iki tikro darbo ledger'io: tai reikalauja operatoriaus
  patvirtinimo ir lieka atviru klausimu po 020-a-02.
