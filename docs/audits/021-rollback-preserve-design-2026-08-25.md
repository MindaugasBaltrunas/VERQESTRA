# 021 — Sprendimas: rollback nebenaikina ledger'io matomo necommit'into darbo (2026-08-25)

> STATUSAS: architect sprendimas R2 spragai. Šis dokumentas **nekeičia jokio produkcinio kodo** —
> jis fiksuoja kryptį ir kontraktą, pagal kurį dirba 021-a-02 … 021-d-05.
> Pirmtakas: [`020-session-writes-ledger-diagnosis-2026-08-25.md`](020-session-writes-ledger-diagnosis-2026-08-25.md)
> — ten R1 (ledger'is aklas) uždarytas per 020-a-02, o R2 paliktas atviru punktu.

## Santrauka

R2 nėra ledger'io spraga. Ledger'is 018 atveju **veikė**: jame gulėjo lygiai tie 2 nuosavi
produkto keliai, kuriuos vėliau atstatė task-scoped rollback'as. Sugedo **seka**: dispatch'as
grįžo, verifikacija nusprendė „nėra commit'o", rollback'as revertino ledger'io kelius į
`base_head`, ir tik **po 13 sekundžių** Stop hook'o commit'as pagaliau įvyko — jau ant
atsuktų failų, tad į commit'ą pateko vien lifecycle keliai.

Todėl sprendimas turi dvi puses, ir nė viena viena nepakanka:

- **Prevencija** — coordinator prieš verifikaciją ribotą langą laukia SAVO stop-bridge
  įrodymo (esamas `waitForOwnStopBridgeDone`, nepakeistas).
- **Sulaikymas** — `restoreTaskScope` prieš atstatydamas kelius išsaugo jų necommit'intą
  turinį į git objektų DB po nuosava ref'a ir grąžina, kur tas darbas guli; ta vieta
  keliauja į `rollback-stable` išvestį, į būsenos įrašą ir į `verify-task` human-review
  priežastį.

Kryptis: rollback'as niekada nebūna paskutinė darbo kopija.

## 018 įrodymų seka

Visos eilutės patikrintos šioje sesijoje tiesiogiai (`vq/logs/orchestrator.log`,
`vq/logs/hooks.log`); numeriai — to paties skaitymo metu.

| Laikas | Šaltinis | Įvykis |
|---|---|---|
| 13:51:56 | `orchestrator.log:1647` | `CLAUDE CONNECTED` — dispatch startas |
| 13:55:31 – 13:57:07 | `hooks.log:2438-2474` | 7 × `post-write:` subagento `Edit` rašymai į `capture-baseline.ts` ir `baseline-report.ts` → **abu keliai ledger'yje** |
| 13:57:18 | `orchestrator.log:1650-1652` | `CLAUDE FINISHED: exit_code=0`; `main=Agent,ScheduleWakeup agent=Bash,Edit,Glob,Grep,Read` |
| 13:57:18 | `orchestrator.log:1653-1667` | `USAGE LEDGER`: `zero_usage_events: 0`, `total_tokens: 278575` → **usage NĖRA tuščia** |
| 13:57:42 | `hooks.log:2480` | `STOP įvykis` (24 s PO to, kai orkestratorius jau atgavo valdymą) |
| 13:57:45 | `hooks.log:2481-2483` | guard'ai ✅ … ir tyla: jokio „Git add", jokio commit'o iš ŠIO Stop bėgimo |
| 13:59:20 | `orchestrator.log:1713` | `CLAUDE DIAGNOSIS (local): verdict=done reason=checks passed …` |
| 13:59:29 | `orchestrator.log:1714-1715` | `ROLLBACK TASK-SCOPED: restored 2 task path(s) to 88a695cc…`; `ROLLBACK DONE` |
| 13:59:29 | `orchestrator.log:1716` | `TASK NOT DONE: … Claude did not create a new commit` |
| 13:59:39 | `hooks.log:2484` | **antras** `STOP įvykis` |
| 13:59:41 | `hooks.log:2485-2486` | `chore(AG/tasks): …018-benchmark….md (+2 failų) (WIP žymė: task=018-benchmark-…)`; `Git add (4 sesijos/lifecycle kelių)` |
| 13:59:42 | `hooks.log:2488` | `git commit:` — commit'as įvyko **12 s po rollback'o** |

Dvi lemiamos šios sekos savybės:

1. **Ledger'is buvo pilnas.** „restored 2 task path(s)" skaičius ateina iš to paties ledger'io
   (`rollback-stable.ts:220` → `rollback-scope.ts:130-147 readTaskScopePaths` →
   `session-write-owners.ts:132 taskScopeRestorePaths`). Kad rollback'as turėtų ką atstatyti,
   keliai jame privalėjo būti. Tai tiesioginis įrodymas, o ne išvada.
2. **Commit'as ne dingo — pavėlavo.** 13:59:41 commit'as sustage'ino tik 4 lifecycle kelius,
   nors ledger'yje tebegulėjo ir 2 produkto keliai. Taip yra todėl, kad `git add` jau atsuktam
   failui yra no-op: rollback'as (13:59:29) turinį buvo grąžinęs į `base_head` 12 s anksčiau.
   Darbas neprarastas transporte — jis buvo **ištrintas** prieš pat commit'ą.

Patvirtinimas repo istorijoje: naujausias `capture-baseline.ts` / `baseline-report.ts`
commit'as tuo metu tebebuvo senas `c5b8c3e` (užfiksuota 020 dokumente); 018 darbo
istorijoje nebuvo.

**Sąžininga išlyga.** `hooks.log` sesijų neskiria, tad kad 13:57:42 ir 13:59:39 `STOP įvykis`
eilutės priklauso būtent dispatch'o vaikui, remiasi netiesioginiu ženklu: 13:59:41 commit
žinutėje yra `WIP žymė: task=018-benchmark-…`. Sprendimas nuo šios išlygos nepriklauso —
abu jo sluoksniai matuoja SAVO nonce, ne žurnalo eilutę.

## Kodėl nesuveikė nė vienas esamas saugiklis

Trys vartai stovėjo šiame kelyje ir visi trys teisėtai praleido:

- **Task 1077 vartas** (`rollback-stable.ts:225` → `committedTaskWorkSince`) saugo tik
  **užcommit'intą** darbą: jis lygina `base_head..HEAD` ir blokuoja content-revert'ą, jei
  keliai jau istorijoje. 018 atveju commit'o dar nebuvo → diff tuščias → vartas praleido.
  Necommit'intas darbas šiandien neturi **jokios** apsaugos — jis yra būtent tai, ką
  rollback'as pagal apibrėžimą tvarko.
- **Esamas stop-bridge laukimo langas** (`claude-dispatch-outcome.ts:99-128`) atsidaro tik per
  `shouldWaitForOwnStopBridge`, t. y. tik prie **dviprasmiško** derinio: `exit=0` **ir** tuščia
  usage **ir** ne usage-limit envelope. 018 usage buvo 278 575 tokenai
  (`orchestrator.log:1653-1667`), tad `isEmptyDispatchUsage` grąžino `false` ir langas
  **neatsidarė nė karto**. Tai ne defektas: tas langas atsakinėja į klausimą „ar tai limitas?",
  o ne „ar hook'as jau spėjo commit'inti?".
- **Verifikacijos „nėra commit'o" šaka** (`verify-task.ts`, `classifyDoneVerdict`) elgėsi
  teisingai pagal savo prielaidą — kad dispatch'ui pasibaigus Stop hook'as jau baigė darbą.
  Prielaida ir yra klaidinga: `on-stop.ts:326` `commitAndPush` vykdomas PRIEŠ `finish()`, o
  `finish()` (`on-stop.ts:62`) yra vienintelė vieta, rašanti stop-bridge įrašą. Vadinasi
  „done" pagal konstrukciją pasirodo **po** commit'o — ir orkestratorius turi tikslų signalą,
  kurio tiesiog nelaukia.

## Krypčių svarstymas

### 1 kryptis — tik bounded laukimas prieš verify

Coordinator prieš verifikaciją laukia savo `own-done`. 018 atveju tai būtų suveikę: nuo
`CLAUDE FINISHED` (13:57:18) iki commit'o (13:59:42) praėjo 143 s, o numatytas langas —
`STOP_BRIDGE_WAIT_MS = 300_000`. Darbas būtų likęs purvinas, hook'as jį sustage'inęs,
`changedProductPathsSince` grąžinęs 2 kelius, verdiktas — `done`.

**Kodėl viena nepakanka.** Tai laiko statymas su privaloma pabaiga: langas turi kietą lubą
(`MAX_STOP_BRIDGE_WAIT_MS = 600_000`), o `AG_DISPATCH_STOP_WAIT_MS=0` jį išjungia visai.
Tos pačios 018 sekos pirmasis Stop bėgimas (13:57:42 → guard'ai 13:57:45 → tyla) rodo Stop
eigą, kuri **niekada** nepriėjo iki commit'o; jei kitas bandymas taip ir baigtųsi, langas
pasibaigtų ir vykdytų **tą patį destruktyvų kelią kaip dabar**. Klaidos kaina lieka 100 %
darbo. Prevencija be sulaikymo tik pastumia lenktynes, o ne pašalina jų pasekmę.

### 2 kryptis — tik necommit'into darbo išsaugojimas prieš rollback'ą

Rollback'as prieš atstatydamas nufotografuoja kelius; darbas atkuriamas ranka.

**Kodėl viena nepakanka.** Ji panaikina žalą, bet ne priežastį. Kiekvienas dispatch'as, kurio
hook'as pavėlavo 3 sekundes, ir toliau baigtųsi `TASK NOT DONE` → human-review → operatoriaus
rankinis `git checkout` iš snapshot'o. Loop'as, kurio paskirtis — sukti eilę be žmogaus,
sistemingai remtųsi į žmogų ten, kur realios problemos nėra. Be to, išsaugojimas negali
atskirti „hook'as vėluoja 3 s" nuo „hook'as mirė": abu atrodo vienodai, tad abu virstų
tuo pačiu rankiniu darbu.

### 3 kryptis — abu sluoksniai (PASIRINKTA)

Laukimas paverčia dažnąjį atvejį (hook'as tiesiog lėtas — etalone išmatuoti ~240 s, nes
„done" rašomas po `commitAndPush`) normaliu `done` be jokio operatoriaus. Išsaugojimas
liekamąjį atvejį (hook'as mirė arba langas baigėsi) paverčia **atkuriamu**, o ne galutiniu.

Sluoksniai dengia skirtingus gedimus ir vienas kito nedubliuoja:

| Gedimas | 1 kryptis | 2 kryptis | 3 kryptis |
|---|---|---|---|
| Hook'as vėluoja lange | ✅ done, be žmogaus | ⚠️ human-review + rankinis atkūrimas | ✅ done |
| Hook'as vėluoja ilgiau nei langas | ❌ darbas sunaikintas | ✅ darbas išsaugotas | ✅ išsaugotas + priežastyje nurodyta vieta |
| Hook'as niekada nepasiekia commit'o | ❌ darbas sunaikintas | ✅ išsaugotas | ✅ išsaugotas |
| Langas išjungtas (`…WAIT_MS=0`) | ❌ darbas sunaikintas | ✅ išsaugotas | ✅ išsaugotas |

Papildomas argumentas dėl tvarkos: išsaugojimas yra fail-closed vartas, tad jis privalo
egzistuoti **anksčiau** už laukimą. Todėl 021-a → 021-b → 021-c → 021-d, ir kiekvienas
tarpinis taškas yra saugesnis už dabartinį, o ne pusiau sulaužytas.

## Kontraktas

### C1 — `restoreTaskScope` išsaugo necommit'intą turinį (021-a-02)

Failas: `src/infrastructure/git/rollback-scope.ts`.

Prieš atstatymo kilpą (kilpa yra destruktyvi nuo pirmos iteracijos — `git checkout <ref> -- p`
perrašo ir worktree, ir indeksą) sukuriamas **git commit objektas**, kurio medis lygus
`stableRef` medžiui su task'o kelių DABARTINIU turiniu.

Kodėl commit objektas, o ne katalogas: `vq/state/rollback-snapshots/` (esamas `reset` režimo
kelias, `rollback-stable.ts:98-135`) yra patch + untracked kopija — tinka žmogui skaityti,
netinka mašinai atkurti. Commit'as atkuriamas viena komanda
(`git checkout <ref> -- <keliai>`), diffinasi prieš `stableRef` ir jam galioja įprastos git
garantijos. Antra: task'o SUKURTI failai (`stableRef` jų neturi) į `git stash create` nepatenka,
o į medį per laikiną indeksą — patenka.

Mechanika (viskas plumbing lygmeniu; realus indeksas ir worktree **neliečiami**):

```text
GIT_INDEX_FILE=<os.tmpdir()>/verqestra-preserve-<pid>.index   (run() jau priima `env`)
  git read-tree <stableRef>                       # bazė = stabili būsena
  git update-index --add --remove -- <task keliai># tik ledger'io keliai, dabartinis turinys
  git write-tree                                  # → tree sha
  jei tree === <stableRef>^{tree}  → nėra ko saugoti, `preserved` neįrašomas
  git commit-tree <tree> -p <stableRef> -m "verqestra: preserved task scope"
  git update-ref refs/verqestra/preserved/<commit-sha> <commit-sha>
```

`update-ref` yra privalomas: be ref'o commit'as lieka dangling ir `git gc` jį teisėtai
sušluoja — „išsaugotas" darbas, kurio negarantuoja niekas, nėra išsaugotas. Ref'as
vardijamas **savo paties sha**, o ne task id: `restoreTaskScope(root, stableRef, paths)`
task id negauna, o parametro pridėjimas be kvietėjo (kvietėjas atsiranda tik 021-b) būtų
pakibęs argumentas. Susiejimą task ↔ ref daro būsenos įrašas (C2), kuris task id turi.

Grąžinamas tipas plečiamas **optional** lauku (`exactOptionalPropertyTypes` — per sąlyginį
spread'ą):

```ts
export type TaskScopeRestoreResult =
  | { ok: true; restored: string[]; preserved?: PreservedTaskScope }
  | { ok: false; failures: string[] };

export type PreservedTaskScope = {
  /** `refs/verqestra/preserved/<sha>` — GC nesušluos. */
  ref: string;
  /** To paties objekto sha (ref'as ir sha sutampa sąmoningai). */
  commit: string;
  /** Bazė, prieš kurią diffinasi išsaugotas darbas. */
  baseRef: string;
  /** Keliai, kurių turinys skyrėsi nuo `baseRef` ir buvo išsaugoti. */
  paths: string[];
};
```

Fail-closed taisyklė (021-a-02 „Veiksmas"): **bet kuri** išsaugojimo grandinės git nesėkmė
grąžina `{ ok: false, failures }` ir kilpa **nepaleidžiama**. Kvietėjas tada blokuoja
(`rollback-stable.ts:234-238` jau turi tą šaką) ir task'as eina į human-review su purvinu,
bet gyvu medžiu. Nesėkmė niekada nevirsta „tęsiam be snapshot'o".

Du atvejai, kurie **nėra** nesėkmė ir `preserved` lauko negrąžina: `paths.length === 0` ir
tree, lygus `stableRef` medžiui (nėra ko saugoti). Abu palieka `ok: true` ir dabartinį elgesį
nepakitusį.

### C2 — kur išsaugojimas įrašomas ir kaip pasiekia išvestį (021-b-03)

Failas: `src/interfaces/cli/bootstrap/rollback-stable.ts`.

1. Porto tipas `TaskScopeRestoreOutcome` (`rollback-stable.ts:29`) gauna tą patį optional
   `preserved` lauką. Kompozicija (`bootstrap-adapters.ts:271-272`) **nekeičiama**: ten
   esantis eksplicitinis `Promise<TaskScopeRestoreOutcome>` anotavimas praleidžia lauką
   automatiškai, kai jis atsiranda porto tipe.
2. `runTaskScopedRestore` po sėkmingo `restoreTaskScope`, **jei** `preserved` yra:
   - būsenos įrašas per esamus portus (`makeDirectory` + `writeTextFile`, `context.now()`):

     ```text
     <runtimeRoot>/state/rollback-preserved/<task-id>.json
     { "task_id", "ref", "commit", "base_ref", "paths": [...], "recorded_at": "<ISO>" }
     ```

   - **viena kanoninė, grep'inama eilutė** į `io.out` IR `agLog` (ta pati eilutė abiem):

     ```text
     ROLLBACK PRESERVED: task=<id> ref=<ref> commit=<sha> paths=<n> record=<abs kelias>
     ```

   Eilutė spausdinama **prieš** esamą `ROLLBACK TASK-SCOPED: restored N task path(s) to <ref>`,
   kad operatorius pirma pamatytų, kur darbas guli, ir tik tada — ką rollback'as padarė.
3. Kai `preserved` nėra — nespausdinama nieko naujo, įrašas nerašomas, elgesys identiškas
   dabartiniam. Jokio fail-open kelio: „nėra ką saugoti" ir „nepavyko išsaugoti" yra
   skirtingos baigtys, ir antroji į šią šaką apskritai nepatenka (C1 ją paverčia `ok:false`).
4. `--task-id` be `--allow-task-changes` (reset režimas) šio kelio neliečia — reset režimas
   turi savo `writeRollbackSnapshot` ir lieka nepakeistas.

### C3 — `verify-task` human-review priežastis (021-c-04)

Failas: `src/application/task-execution/verify-task.ts`.

Vienintelis kvietimas keičiasi iš `ports.cli.run` į **jau egzistuojantį**
`ports.cli.runCaptured` (`run-coordinator-ports.ts:68`) — naujo porto **nereikia**, o tai ir
yra priežastis, kodėl C2 kanoninė eilutė eina į **stdout**, o ne vien į žurnalą:

```ts
const rollback = await ports.cli.runCaptured(["rollback-stable", "--allow-task-changes", "--task-id", state.taskId]);
if (rollback.code !== 0) { /* nepakitusi šaka: rollback_failed=<kodas> missing_commit */ }
const preservedRef = /^ROLLBACK PRESERVED: .*\bref=(\S+)/m.exec(rollback.output)?.[1];
```

Priežastis papildoma tik tada, kai `preservedRef` yra:

```text
TASK NOT DONE: <task-id> Claude did not create a new commit preserved_work=<ref>
```

Nėra atitikmens → priežastis lieka **žodis į žodį** tokia pat kaip dabar. Tai svarbu: 018 ir
ankstesnių bėgimų priežasčių tekstai yra grep'inami artefaktai, ir jų forma be reikalo
nekeičiama. Ta pati taisyklė galioja visoms trims `noCompletionSignalReason` šakoms
(`clean tree without work evidence…`, `Claude did not create a new commit`,
`no verified product changes (non-git project)`) — sufiksas prisegamas prie galutinės
eilutės, o ne dubliuojamas kiekvienoje šakoje.

Regresinis testas (`src/tests/task-execution-run.test.ts`) atkuria 018: ledger'yje 2 nuosavi
keliai, commit'o nėra, `verdict=done`, `runCaptured` grąžina `ROLLBACK PRESERVED: …` →
rezultatas `human-review`, kurio `reason` turi `preserved_work=`.

### C4 — coordinator laukia savo stop-bridge įrodymo (021-d-05)

Failas: `src/composition/loop/coordinator-execution-adapters.ts`.

Antras laukimo taškas, o ne esamo perkėlimas — esamas
(`claude-dispatch-outcome.ts:99-128`) atsakinėja į kitą klausimą ir 018 atveju neatsidarė
(žr. „Kodėl nesuveikė"). Naujasis nesąlygojamas usage forma: prieš `verifyTask` iškvietimą,
kai `AG_DISPATCH_NONCE` netuščias, kviečiamas **nepakeistas**
`waitForOwnStopBridgeDone({ probe, timeoutMs: stopBridgeWaitMs(), pollMs: STOP_BRIDGE_WAIT_POLL_MS })`
su tokiu pačiu probe, koks jau surištas dispatch kelyje (`mergeStopBridgeSources` ant
attempt + global šaltinių).

- `own-done` nutraukia laukimą iškart (kilpa taip ir elgiasi) → verify bėga kaip dabar.
- Timeout **verdikto nekeičia** ir nieko neblokuoja: jis tik nebeleidžia verify aplenkti
  hook'o. Rezultatas nusėda į žurnalą tuo pačiu formatu kaip dispatch kelyje
  (`… STOP WAIT RESULT: … result=<own-done|timeout> waited_ms=… polls=…`).
- `foreign-done` **nėra** pabaiga — svetimas įrodymas apie mus nesako nieko, tad laukiama
  toliau iki lango pabaigos (`waitForOwnStopBridgeDone` tai jau daro).
- Jokių naujų konstantų: langas ir luba imami iš `stopBridgeWaitMs()` /
  `MAX_STOP_BRIDGE_WAIT_MS`, tad `AG_DISPATCH_STOP_WAIT_MS=0` išjungia abu laukimo taškus
  vienodai.

## `stop-bridge` kontraktas neliečiamas

`src/application/task-execution/stop-bridge-wait.ts` naudojamas **nepakeistas**: 021-d importuoja
`waitForOwnStopBridgeDone`, `stopBridgeWaitMs`, `STOP_BRIDGE_WAIT_POLL_MS` ir
`mergeStopBridgeSources` tokius, kokie jie yra. Nekeičiamos nei grynos taisyklės, nei
`shouldWaitForOwnStopBridge` sąlyga (naujasis taškas jos apskritai nenaudoja — jam laukimo
kriterijus yra „esame dispatch'e", ne „usage dviprasmiška").

`src/infrastructure/state/stop-bridge/**` — **neliečiamas**. Jei kuris nors tolesnis darbas
atsirems į poreikį keisti tą kontraktą (pvz. prireiktų naujo lauko stop-bridge įraše),
tai yra **atskiro patvirtinimo riba**: darbas sustabdomas, o ne apeinamas.

Nekeičiama taip pat: `templates/.claude/settings.json`, `src/interfaces/hooks/on-stop.ts`,
`src/interfaces/hooks/session-write-ledger.ts`, `src/domain/git/rollback-rules.js` taisyklės,
`src/composition/runtime/bootstrap-adapters.ts`.

## Failai, kurie keisis tolesniuose darbuose

| Darbas | Produkcinis failas | Testas |
|---|---|---|
| 021-a-02 | `src/infrastructure/git/rollback-scope.ts` | `src/tests/infrastructure-git.test.ts` |
| 021-b-03 | `src/interfaces/cli/bootstrap/rollback-stable.ts` | `src/tests/interfaces-cli-rollback-stable.test.ts` |
| 021-c-04 | `src/application/task-execution/verify-task.ts` | `src/tests/task-execution-run.test.ts` |
| 021-d-05 | `src/composition/loop/coordinator-execution-adapters.ts` | `src/tests/composition-cli.test.ts` |

Kiekvieno darbo „Failai / Leidžiama" sąrašas su šia lentele sutampa — priešingai nei 020-a-02
atveju, kur sąrašas ir taikinys buvo prasilenkę. Sluoksnių ribos išlaikomos: git plumbing lieka
`infrastructure`, sprendimas „ką sakyti operatoriui" — `interfaces`, sprendimas „ar task'as
padarytas" — `application`, laukimo suriša — `composition`.

## Rizikos

- **Objektų DB augimas.** Kiekvienas nesėkmingas bandymas palieka commit'ą po
  `refs/verqestra/preserved/*`. Tai sąmoninga: prarasto darbo kaina nepalyginamai didesnė už
  kelis kilobaitus. Valymo politika (pvz. ref'ų retencija) **nėra** šio sprendimo dalis ir
  turi eiti atskiru darbu, kai ref'ų realiai susikaups.
- **Laikinas indekso failas.** `GIT_INDEX_FILE` rodo į `os.tmpdir()`, ne į repo — realus
  `.git/index` nepaliečiamas jokioje šakoje, įskaitant nesėkmės. Failas ištrinamas `finally`
  bloke; jo likutis tmp kataloge nekenkia.
- **Antras laukimo taškas ilgina bloguoju atveju.** Timeout'as prideda iki lango trukmės
  vienam nepavykusiam dispatch'ui. Priimta: tai ta pati luba, kurią operatorius jau valdo
  `AG_DISPATCH_STOP_WAIT_MS`, o alternatyva — sunaikintas darbas.
- **`preserved_work=` priežasties tekste.** Priežasčių eilutės yra grep'inami artefaktai;
  sufiksas prisegamas tik esant įrašui, tad esami grep'ai (`TASK NOT DONE: <id> Claude did
  not create a new commit`) toliau atitinka prefiksą.

## Ko šis dokumentas nedaro

- Nekeičia jokio `src/**` failo. Vienintelis šios sesijos rašymas — šis `.md`.
- Nesprendžia `hook-post-bash` praplėtimo iki tikro darbo ledger'io (lieka atviras klausimas
  po 020-a-02, reikalauja operatoriaus patvirtinimo dėl `templates/.claude/settings.json`).
- Neliečia R1 (uždaryta 020-a-02) ir 015 matomumo dalies (`diagnose-evidence.ts:86-90`,
  atskiras 020-b-03).
- Nesiūlo `refs/verqestra/preserved/*` retencijos politikos — žr. „Rizikos".
