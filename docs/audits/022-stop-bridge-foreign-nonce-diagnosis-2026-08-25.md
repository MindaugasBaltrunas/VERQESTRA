# 022 — `DISPATCH STOP BRIDGE FOREIGN`: kieno nonce guli tilte?

- Data: 2026-08-25
- Šaltiniai: `vq/logs/orchestrator.log`, `vq/logs/hooks.log`, `vq/runtime/runs/**/stop-state.json`
- Giminingas radinys: `docs/audits/020-session-writes-ledger-diagnosis-2026-08-25.md` (R2 — Stop
  hook'o commit'as nespėja iki dispatch pabaigos)
- Produkcinis kodas šioje dalyje NEKEISTAS.

## Verdiktas — hipotezė PANEIGTA, darbas sustabdytas

Tikrinta hipotezė: *`DISPATCH STOP BRIDGE FOREIGN` yra TO PATIES task'o ankstesnio bandymo
vėlavęs Stop hook'as.*

**Žurnalas ją paneigia kaip bendrą 4 įvykių paaiškinimą.** Dviejuose iš keturių įvykių
(012 @ 08:35:09, 021-d-05 @ 19:20:43) task'as buvo vykdomas PIRMĄ kartą — ankstesnio bandymo,
kurio Stop hook'as galėtų vėluoti, tiesiog nebuvo. Trečiajame (007 @ 10:10:53) ankstesnis
bandymas nutrūko `exit=74` (`INFRASTRUCTURE_IO_EXIT_CODE`) dar prieš paleidžiant Claude sesiją,
tad Stop hook'o jame irgi nebuvo. Tik vienas įvykis (010 @ 08:04:55) su hipoteze suderinamas.

Pagal užduoties `## Stop` sąlygą — **kodo keitimo šioje dalyje nesiūlau ir laukiu operatoriaus
sprendimo**. Kryptys 1/2/3 žemiau aprašytos faktais, bet **nė viena nepasirinkta**.

## 0. Metodo riba, kurią privaloma žinoti pirma

Tiesioginis „šis nonce priklauso anam bandymui" sutapdinimas nė vienam iš 4 įvykių
**neatkuriamas iš žurnalo**, nes:

1. **Nonce reikšmė niekur nelogeriama.** `grep -n "dispatch_nonce" vq/logs/orchestrator.log`
   grąžina lygiai 4 eilutes — pačias `FOREIGN` eilutes, kuriose reikšmės nėra
   (`claude-dispatch-outcome.ts:132-134` rašo tik `task=` ir žodžius „nesutampa").
2. **Vienintelis artefaktas su reikšme yra pats tiltas — ir jis trinamas.**
   `dispatch-prelaunch.ts:77-78` prieš kiekvieną paleidimą `removeIfExists`'ina
   `vq/state/claude-stop-status.json` ir `vq/logs/claude-stop.log`.
3. **Attempt veidrodžio tais momentais nebuvo.** Visi 4 dispatch'ai loge pažymėti
   `runtime attempt namespace unavailable ... reason=no-runtime — artifacts fall back to global
   mirrors` (eilutės 676, 845, 1388, 3182), tad `<attempt>/stop-state.json` neparašytas.
   Išlikę `stop-state.json` failai `vq/runtime/runs/**` priklauso VĖLESNIEMS bandymams
   (pvz. 012 `a2` — `2026-08-25T10:04:28.671Z`, nonce `e57c253ef460663e7cb69004eeacc9dd`;
   021-d-05 `a1` — `2026-08-25T19:29:34.300Z`, nonce `b9a2e4c58a4652b7f46f3ae9c0e11641`),
   t. y. jau PO tiriamųjų įvykių.

Todėl žemiau naudojamas **eliminacijos** įrodymas: kas galėjo įrašyti `status=done` į ką tik
ištrintą tiltą tarp paleidimo ir baigties, ir kurie kandidatai loge egzistuoja.

Rašytojų aibė yra uždara ir maža: `.claude/settings.json` registruoja **tik `Stop` →
`hook-on-stop`** (jokio `SubagentStop`, jokio `on-stop-bridge`). Taigi globalų tiltą rašo
lygiai vienas kelias — gyvos Claude sesijos Stop hook'as
(`on-stop.ts:62` → `stop-adapters.ts:98` → `stop-bridge.ts:161 stopBridgeForProject`),
o jo `dispatch_nonce` = tos sesijos paveldėtas `AG_DISPATCH_NONCE`
(`stop-bridge.ts:179`), arba `""`, jei sesija paleista ne per dispatch launcher'į.

## 1. Įrodymai — visi 4 FOREIGN įvykiai

| # | Laikas | Task | Bandymas | Ankstesnio TO PATIES task'o Stop hook'as įmanomas? | Koreliacija |
|---|---|---|---|---|---|
| 1 | 08:04:55 | `010-u-daryti-preflight-…` | **2-as** | **TAIP** | `human_review` @ 08:05:50 |
| 2 | 08:35:09 | `012-automatizuoti-project-status-…` | **1-as** | **NE — bandymų nebuvo** | `repair` @ 08:36:57 → `human_review` @ 08:47:05 |
| 3 | 10:10:53 | `007-paleisti-piln-queue-loop-…` | **2-as** | **NE — 1-as krito `exit=74` prieš paleidimą** | `human_review` @ 10:12:59 |
| 4 | 19:20:43 | `021-d-05-a-05-dispatch-pabaiga-…` | **1-as** | **NE — bandymų nebuvo** | `LOOP ABORT` + requeue @ 19:20:43 |

### Įvykis 1 — 010 @ 2026-08-25 08:04:55 (VIENINTELIS suderinamas su hipoteze)

```text
591  [07:48:15] TASK ACTIVE: 010-…
599  [07:48:17] CLAUDE CONNECTED: visible PowerShell task runner … < 010-….md      ← 1 bandymas
602  [07:52:33] CLAUDE FINISHED: exit_code=1 …
603  [07:52:33] DISPATCH TOOL USAGE: … events=29 …                                  ← sesija REALIAI dirbo
664  [07:52:33] LOOP ABORT (infrastruktura): stage=dispatch exit=1 … returned_to_queue=010-….md
669  [07:57:34] WAVE RESUME: retry-task task=010-… (rr1:retry-task requeued-task)
679  [07:57:38] CLAUDE CONNECTED: … < 010-….md                                      ← 2 bandymas
682  [08:04:55] DISPATCH STOP BRIDGE FOREIGN: task=010-… status=done bet dispatch_nonce nesutampa
683  [08:04:55] CLAUDE FINISHED: exit_code=1 …
747  [08:05:50] CLAUDE DIAGNOSIS (local): … verdict=human_review reason=changed files outside allowed paths
```

1-as bandymas turėjo gyvą Claude sesiją (`events=29` sutool'inta), tad jo Stop hook'as
egzistavo ir galėjo pavėluoti. Tai vienintelis atvejis, kur „to paties task'o ankstesnis
bandymas" yra galimas rašytojas. Bet net čia tai lieka **galimybė, ne įrodymas** — nonce
reikšmės nėra (žr. §0).

### Įvykis 2 — 012 @ 2026-08-25 08:35:09 (PANEIGIA)

```text
836  [08:27:34] TASK NOT DONE: 011-… clean tree without work evidence
839  [08:27:35] TASK ACTIVE: 012-automatizuoti-project-status-…
848  [08:28:01] CLAUDE CONNECTED: … < 012-….md                       ← PIRMAS ir vienintelis bandymas
851  [08:35:09] DISPATCH STOP BRIDGE FOREIGN: task=012-… status=done bet dispatch_nonce nesutampa
916  [08:36:57] CLAUDE DIAGNOSIS (local): … verdict=repair reason=clear local issue: AssertionError …
1013 [08:47:08] TASK HUMAN REVIEW/ROLLBACK: task=012-… verdict=human_review
```

Tarp `TASK ACTIVE` (08:27:35) ir `FOREIGN` (08:35:09) 012 neturėjo **jokio** ankstesnio
bandymo — pirmasis `CLAUDE CONNECTED` šiam task'ui yra 08:28:01. Prieš tai buvusi dispatch
sesija priklausė **task'ui 011** (`08:18:51`–`08:25:41`, diagnozuota `stop done` @ 08:27:32).
Vadinasi tiltą užpildęs `done` **negalėjo** būti to paties task'o ankstesnio bandymo įrašas.

### Įvykis 3 — 007 @ 2026-08-25 10:10:53 (PANEIGIA)

```text
1118 [09:41:29] CLAUDE CONNECTED: … < 012-….md                        ← 012 dispatch dar gyvas
1141 [09:45:08] TASK ACTIVE: 007-paleisti-piln-queue-loop-…
1149 [09:45:16] CLAUDE CONNECTED: … < 007-….md                        ← 007, 1 bandymas
1152 [09:45:17] DISPATCH LOG UNWRITABLE (infrastructure): task=007-… attempt=absent global=failed —
               D:\VERQESTRA\vq\logs\claude-last.log: EBUSY: resource busy or locked
1153 [09:45:17] CLAUDE RETURNED TO ORCHESTRATOR: task=007-… exit=74
1391 [10:06:23] CLAUDE CONNECTED: … < 007-….md                        ← 007, 2 bandymas
1394 [10:10:53] DISPATCH STOP BRIDGE FOREIGN: task=007-… status=done bet dispatch_nonce nesutampa
1459 [10:12:57] CLAUDE DIAGNOSIS (local): … verdict=human_review reason=local signals are ambiguous
```

007 1-as bandymas grįžo `exit=74` = `INFRASTRUCTURE_IO_EXIT_CODE` (`src/shared/exit-codes.ts:19`)
per `aborted-before-launch` šaką (`command.ts:360`) — Claude sesija nepaleista, Stop hook'o
nebuvo, tad ir nonce niekas neįrašė. To paties task'o vėlavęs Stop hook'as čia neįmanomas.

**Šalutinis, bet svarbus radinys:** `EBUSY` ant `claude-last.log` @ 09:45:17 yra tiesioginis
žurnalo įrodymas, kad **ankstesnio task'o (012) dispatch sesija tebebuvo gyva**, kai naujam
task'ui (007) jau buvo ištrintas tiltas ir perrašytas `current-task-id`. Dispatch'ų
co-tenancy repo šaknyje — ne prielaida, o užfiksuotas faktas.

### Įvykis 4 — 021-d-05 @ 2026-08-25 19:20:43 (PANEIGIA)

```text
3175 [19:01:31] TASK DONE: 021-c-04-a-04-verify-task-human-review-priezastis-018-sekos
3177 [19:01:32] TASK ACTIVE: 021-d-05-a-05-dispatch-pabaiga-…
3185 [19:02:01] CLAUDE CONNECTED: … < 021-d-05-….md                    ← PIRMAS ir vienintelis bandymas
3188 [19:20:43] DISPATCH STOP BRIDGE FOREIGN: task=021-d-05-… status=done bet dispatch_nonce nesutampa
3190 [19:20:43] CLAUDE FINISHED: exit_code=1 …
3252 [19:20:43] LOOP ABORT (infrastruktura): stage=dispatch exit=1 … returned_to_queue=021-d-05-….md
3257 [19:24:52] WAVE RESUME: retry-task task=021-d-05-… (rr1:retry-task requeued-task)
```

Šis įvykis vienintelis pilnai padengtas `vq/logs/hooks.log` (jis prasideda 15:06). Ten matyti,
kad sesijos darbas realiai vyko ir **commit'as įvyko lange**:

```text
1822 [19:02:16.328Z] user-claude runtime praleistas: dispatch sesija (AG_DISPATCH_NONCE)
1891 [19:18:29.315Z] STOP įvykis
1908 [19:20:21.006Z] Automatiškai generuota commit žinutė: feat(src): coordinator-execution-adapters.ts,
                     composition-cli.test.ts (WIP žymė: task=021-d-05-…)
1912 [19:20:21.674Z] git commit: feat(src): coordinator-execution-adapters.ts, composition-cli.test.ts
```

Darbas buvo, commit'as buvo — bet po 22 sekundžių dispatch pabaiga tilte matė **svetimą**
`done` ir baigtis liko `exit=1` → `LOOP ABORT` → requeue.

Papildomai: **visi** `hooks.log` sesijų startai lange 15:06–20:37 pažymėti
`user-claude runtime praleistas: dispatch sesija (AG_DISPATCH_NONCE)` (20 įrašų). Nė vieno
be-nonce (interaktyvios) sesijos starto tame lange nėra. Vadinasi 19:20:43 tilte gulėjęs
`done` **turėjo netuščią nonce** ir priklausė **kitai dispatch sesijai** — o kadangi
021-d-05 buvo pirmas bandymas, ta sesija buvo **kito task'o**.

## 2. Nonce gyvavimo grandinė ir tiksli seka, kuria vėlavęs įrašas praranda darbo įrodymą

Nonce gimsta, gyvena ir miršta taip:

| Žingsnis | Vieta | Kas vyksta |
|---|---|---|
| 1 | `claude-dispatch/command.ts:327` | `dispatchNonce = ports.newDispatchNonce()` — vienas nonce visam bandymui |
| 2 | `dispatch-prelaunch.ts:77-78` | **Ištrinamas** `vq/state/claude-stop-status.json` ir `vq/logs/claude-stop.log` |
| 3 | `dispatch-prelaunch.ts:79` | Perrašomas **globalus** `vq/state/current-task-id` |
| 4 | `claude-launcher.ts:184` | `$env:AG_DISPATCH_NONCE = '<nonce>'` vidiniame pwsh — paveldi sesija ir VISI jos hook'ai |
| 5 | `claude-dispatch-process.ts:126-127` | POSIX atitikmuo: `process.env["AG_DISPATCH_NONCE"]` mutuojamas TIK proceso metu |
| 6 | `slot-task-runner.ts:78` | `CHILD_ENV_RUNTIME_CONTEXT_KEYS` iššluoja `AG_DISPATCH_NONCE` iš vaiko env — kad worktree vaikas nepaveldėtų svetimo nonce |
| 7 | `stop-bridge.ts:90-91` | Attempt rašymo VARTAI: tuščias nonce → `no-nonce`, artefaktas nerašomas |
| 8 | `stop-bridge.ts:179` | Globalaus veidrodžio nonce — iš to paties env, ta pačia trim taisykle |
| 9 | `stop-bridge.ts:185-194` | No-clobber vartai galioja **tik** be-nonce rašytojui; nonce'ą turintis rašytojas perrašo visada |
| 10 | `stop-bridge.ts:215-229` | Atominis `writeTextFile` — **paskutinis rašytojas laimi, istorijos nėra** |
| 11 | `stop-bridge-wait.ts:50-61` | `classifyStopBridgeDone`: `status==="done" && nonce===mano ? own-done : foreign-done` |
| 12 | `stop-bridge-wait.ts:137-138` | `foreign-done` nugali `none` |
| 13 | `stop-bridge-wait.ts:184` | `foreign-done` **lipnus** — vėlesnis `none` jo nenutrina |
| 14 | `claude-dispatch-outcome.ts:130-135` | `stopBridgeDone = (classification === "own-done")` → `false`; rašoma FOREIGN eilutė |

Seka, kuria darbo įrodymas dingsta (viskas viename `vq/state/claude-stop-status.json` faile):

1. **T0** — bandymas A paleidžiamas su nonce `N_A`; prelaunch ištrina tiltą (žingsnis 2).
2. **T1** — A sesijos Stop hook'as parašo `{status:"done", dispatch_nonce:N_A}`. Tuo momentu
   tiltas teisingas.
3. **T2** — kitas bandymas B (to paties arba kito task'o) startuoja: prelaunch **vėl ištrina**
   tiltą ir perrašo `current-task-id` į `T_B`. A įrodymas dingsta be pėdsako.
4. **T3** — A sesija VIS DAR gyva (žr. §1 įvykį 3: `EBUSY`; taip pat launcher watchdog duoda
   `stopDoneGraceMs = 180000`, `claude-launcher.ts:238`), ir jos Stop hook'as suveikia dar kartą.
   Jis rašo `{status:"done", dispatch_nonce:N_A, task_id: T_B}` — `task_id` imamas iš
   **globalaus** `current-task-id` (`on-stop.ts:227`), tad įrašas **atrodo** priklausantis B.
   No-clobber vartai (žingsnis 9) jo nestabdo: `N_A` nėra tuščias.
5. **T4** — B sesijos Stop hook'as parašo savo `{done, N_B}`. Tvarka nuo šio momento —
   lenktynės: jei T3 įvyko PO T4, faile lieka `N_A`.
6. **T5** — B dispatch baigtis kviečia `probeStopBridge` → `mergeStopBridgeSources` mato
   `status=done`, `nonce=N_A ≠ N_B` → `foreign-done` → `stopBridgeDone=false`.
7. **T6** — `claude-dispatch-outcome.ts:130` numeta B darbo įrodymą. `exit=1` lieka `exit=1`;
   `isZeroUsageLimitSignal` (`stop-bridge-wait.ts:34-40`) čia nieko nekeičia, nes usage netuščia.
   Rezultatas — `LOOP ABORT (infrastruktura)` ir requeue **be** repair ciklo, nors commit'as
   realiai įvyko (įvykis 4: commit @ 19:20:21, FOREIGN @ 19:20:43).

**Esminė spraga:** tiltas neturi nei kartos (generation), nei laiko lango, nei rašytojo
tapatybės. `foreign-done` reiškia lygiai vieną dalyką — „nonce ne mano" — ir sulydo į vieną
reikšmę tris skirtingas situacijas: (a) tikras lygiagretus svetimas dispatch'as,
(b) **pasenęs, jau nebeaktyvaus bandymo įrašas**, (c) be-nonce interaktyvios sesijos įrašas.
Diagnostikai reikalinga būtent (b) — ir jos šiandien atskirti neįmanoma nei kodui, nei žmogui.

## 3. Kodėl nesukuriamas repair ciklas

`foreign-done` nėra atskiras baigties signalas — jis tik **neleidžia** `stopBridgeDone` tapti
`true`. Todėl:

- `exit=1` iš Claude CLI lieka `exit=1`;
- `isInfrastructureExitCode` jį klasifikuoja kaip infrastruktūros gedimą → `LOOP ABORT`;
- task'as grąžinamas į eilę **be** klaidos parašo, tad `retry-guard` skaitikliai ir
  `CLAUDE DIAGNOSIS` repair šaka nepasiekiamos (įvykis 4, eilutės 3252–3257);
- kituose trijuose įvykiuose diagnozė nusileido į `human_review` (§1 lentelė) — t. y. darbas
  sustojo ties operatoriumi, o ne ties automatiniu repair'u.

Tai tiesiogiai remia 020 audito **R2**: Stop hook'o įrodymas ir dispatch pabaiga nėra
sinchronizuoti, tik čia praradimo priežastis kita — ne vėlavimas, o **perrašytas ir po to
svetimu įrašu užpildytas vienintelis globalus slot'as**.

## 4. Kryptys — aprašytos, NEPASIRINKTOS

Pagal `## Stop` sąlygą kryptis nesirenkama. Faktai, kurių reikės sprendimui:

**Kryptis 1 — tiltas praturtinamas rašytojo tapatybe.**
Įrašas gautų papildomus laukus (pvz. `attempt_ref`, `run_id`, `worker_id`, `written_at_pid`),
kad `foreign-done` skiltų į `foreign-live` ir `foreign-stale`. Kaina: rašytojas
(`stop-bridge.ts:215`) ir skaitytojas (`stop-bridge-wait.ts:50`) keičiami kartu.
Pastaba: `task_id` šiam tikslui **netinka** — jis imamas iš globalaus `current-task-id`
(`on-stop.ts:227`), tad pavėlavęs svetimos sesijos įrašas neša BŪTENT dabartinį task'ą
(žr. §2 žingsnį 4).

**Kryptis 2 — neaktyvaus nonce įrašas žymimas `stale`.**
Prelaunch (`dispatch-prelaunch.ts:77`) tiltą trina; vietoje trynimo jis galėtų palikti
paskutinį įrašą pažymėtą `stale`, arba rašytojas galėtų pats atpažinti, kad jo nonce nebėra
aktyvus. Kaina mažesnė, bet reikia atsakyti, **kas** yra „aktyvaus nonce" registras — šiandien
tokio nėra (nonce gyvena tik proceso env, `claude-dispatch-process.ts:126-127`).

**Kryptis 3 — abi.**

**`stopStateSchema` atgalinis suderinamumas (`stop-bridge.ts:24-37`) — faktai, ne nuomonė:**

- Schema yra `z.looseObject` — **nedeklaruoti laukai praeina** ir yra išsaugomi. Naujas laukas
  senų failų neskaldo net ir tada, kai skaitytojas jo nesitiki.
- `schema_version` **sąmoningai nėra** (komentaras `stop-bridge.ts:21-23`): dokumentas
  apibrėžtas kaip to paties lauko rinkinio kopija, o evoliucijos kelias — `looseObject` + CAS
  revision.
- `status: z.string()` yra **tyčia NE enum** (`stop-bridge.ts:26`) — naujas statusas netampa
  schema read failure.
- Todėl **bet kuris naujas laukas privalo būti `.optional()` arba `.default(...)`**: seni
  įrašai (pvz. išlikęs `vq/runtime/runs/…/012-…/attempts/a2/stop-state.json`) turi lygiai
  septynis laukus — `date`, `status`, `reason`, `task_id`, `dispatch_nonce`, `head`,
  `git_status`. Privalomas naujas laukas juos paverstų `invalid-payload`.
- Priešinga kryptimi rizikos nėra: `reason`, `head`, `git_status` jau turi `default("")`, o
  `dispatch_nonce: z.string().min(1)` lieka rašymo VARTAIS (tuščias nonce = interaktyvi sesija),
  tad jo semantikos keisti nereikia nė vienoje kryptyje.

## 5. Ko ši diagnozė NEUŽDARO

- **Nenustato rašytojo tapatybės nė viename iš 4 įvykių.** Tai neįmanoma su dabartine
  instrumentacija (§0). Pigiausias tai keičiantis žingsnis — įrašyti nonce prefiksą į
  `DISPATCH STOP BRIDGE FOREIGN` eilutę ir į `DISPATCH STOP WAIT RESULT`; be to kita tokia
  diagnozė vėl remsis eliminacija.
- **Nesiūlo kodo keitimo** — pagal `## Stop` sąlygą laukiama operatoriaus sprendimo dėl
  krypties 1 / 2 / 3.
- **Neliečia** `slot-task-runner.ts:78` nonce valymo kontrakto ir R1/R2 darbų
  (uždaryti 020-a-02 ir 021 grandinėje).

## Priedas — kaip atkartoti įrodymus

```bash
grep -n "FOREIGN" vq/logs/orchestrator.log
grep -n "dispatch_nonce" vq/logs/orchestrator.log        # 4 eilutės, reikšmių NĖRA
grep -n "user-claude" vq/logs/hooks.log                  # 20 startų, visi su AG_DISPATCH_NONCE
grep -rln "dispatch_nonce" vq/runtime/runs/               # išlikę attempt veidrodžiai
```
