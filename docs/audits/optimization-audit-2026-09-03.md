# Optimizavimo galimybių auditas — kur eina pinigai ir laikas

Data: 2026-09-03. Duomenys: `vq/logs/token-usage.jsonl` (922 įrašai, 306 dispatch'ai su usage),
`vq/logs/orchestrator.log` (2026-08-21 → 09-03, 13 dienų), `vq/logs/hooks.log{,.1}`
(09-01 21:15 → 09-03 17:52), `vq/logs/context-size.jsonl`, `vq/config/*`. Sumos apytikslės
(kaštų kibirai × vidurkiai; skriptai sandbox'e blokuoti), kryptys vienareikšmės.

## Kur eina pinigai (13 dienų)

| Fazė | Įrašų | Įvertis | Pastaba |
|---|---|---|---|
| dispatch | 294 su kaina | **≈ 510 $** | 122 × 0,1–1 $; 160 × 1–5 $; 9 × 5–10 $; 3 × >10 $ |
| preflight LLM | 125 | **≈ 55 $** | 79 × 0,1–0,5 $; 44 × 0,5–1 $; 85 opus / 40 sonnet |
| diagnose | 298 | 0 $ | 263 local + 35 fastpath — deterministiniai |
| **Viso** | | **≈ 565 $ ≈ 43 $/d.** | |

Dispatch'o kaina auga su turn'ų skaičiumi, ne su prompt'u (kompresijos auditas 09-03): 4 turn'ai →
0,21 $, 105 turn'ai → 10,47 $. Mediana ≈ 30 turn'ų, p75 ≈ 47, max 118.

Pagal modelį: **opus — 68 dispatch'ai (22 %), ≈ 216 $ (≈ 42 % išlaidų)**; visi 12 dispatch'ų ≥ 5 $
yra opus. Sonnet — 236, ≈ 290 $. Nesėkmės: opus 2/68 (3 %), sonnet 18/236 (7,6 %) — bet
13 iš 18 sonnet nesėkmių yra turn'ų lubos (žr. L1), be jų sonnet ≈ 2 %.

## Kur eina laikas

- **Vartai.** `hooks.log`: 122 × `pnpm test` per 44,6 h → **≈ 66 paleidimai/d. × ≈ 3,5 min ≈ 3,9 h/d.**
  Kiekvienas = lint + build + 2287 node testai (159 s) + ui-app typecheck/test (27 s). Vienam
  dispatch'ui — ≥ 3 pilni paleidimai (worker'io Patikra, worker'io Stop hook'as, verify).
- **Ciklo sustojimai.** `LOOP STOP` 73 kartus, 40 iš jų `all-blocked` — kiekvienas laukia
  operatoriaus restarto; tarp jų eilė stovi.
- **Antras slot'as.** `WORKER POOL … granted=2/2` **10 kartų** prieš `granted=1/2` 179. Matomos
  priežastys: `single-candidate` 34, `allowed-paths` (scope sankirta) 19, `unknown-scope` 10;
  likusios eilutės — planuoklės buhalterija (`missing-lease` 523, `hard-cap` 471), kuri užgožia
  tikrą priežastį.
- **Dispatch'o trukmė** (tik nenulinių exit'ų): 29 ≥ 16,7 min, max 80 min.

## Radiniai — svertai pagal naudą

### L1 (P1) — medium tier turn'ų lubos (60) kerta ties p92 ir nužudo 87 % pasiektų runų

`token-budget.json turnLimits.medium: 60`. **15 dispatch'ų baigė tiksliai 61 turn'u: 13 failed,
2 succeeded.** Jų kaina: 4,0+2,7+4,4+2,8+2,8+3,1+3,1+2,1+2,4+3,3+2,3+2,4+4,6+3,3+2,4 = **≈ 46 $**
sudeginta darbui, kuris buvo nukirstas prieš pabaigą, plius repair/retry ratas ir human-review
kaina po to. Repair lubos (30): 13 pasiekė 31, 3 failed. Large lubos (180) — nė karto.
Mediana 30, p75 47 — lubos 60 stovi ten, kur darbas jau beveik padarytas.

Svertas: `medium` 60 → 90–100 (arba: lubos pratęsiamos, kai paskutiniuose turn'uose yra Edit/Write
ir žalias `pnpm test` — worker'is dirba, ne klaidžioja). Tikėtina: −13 nesėkmių / 13 d., −46 $
tiesiogiai, −3 pilni vartų paleidimai kiekvienam nukirstam run'ui. Rizika: ilgesnė uodega vienam
run'ui — bet 180 lubos didelėms niekada nesuveikė, tad realus limitas ir taip yra darbo pabaiga.

### L2 (P1) — klasifikacijos žodynas sutampa su projekto kalba → 22 % dispatch'ų opus, 50 % — large biudžetas

`preflight` tier eilutės (284): **large 143 (biudžeto pakopa, 180 turn'ų), medium 141.** Eilutės
`model=opus` žymė yra biudžeto pakopos užuomina, NE vykdymo modelis: realų modelį skiria
`MODEL ROUTING` pagal klasifikacijos bazinę pakopą — `advanced` → opus 55 kartų, `risk-signals` 1,
eskalacija 1; iš viso **opus 68 iš 306 dispatch'ų (22 %)**. „classification sensitivity is high" —
79 kartus; „structurally large" (keliai/veiksmai/domenai) — 91, ir jis kelia TIK turn'ų biudžetą.
(Pataisyta 2026-09-03 modelių audite: pirminė versija šias dvi pakopas suliejo į „45 % opus".) `task-classification-policy.json` „high"
kategorijos raktažodžiai: `policy`, `dependency`, `boundary`, `architecture`, `approval`,
`security`, `permission`. VERQESTRA **yra** orkestravimo politikų, ribų ir priklausomybių
produktas — tie žodžiai yra kasdienė task'ų kalba, ne rizikos signalas. Pvz. 154 (analitikos
skaitytuvo predikatas) gavo „sensitivity is high" ir opus/large.

Svertas: (a) `high` tik iš KELIŲ (`/auth/`, `migrations/`, `security-policy.json`), ne iš
žodžių; (b) žodžių sąrašą siaurinti iki nedviprasmiškų (`secret`, `password`, `migration`);
(c) eksplicitinė task'o žyma rizikai vietoje spėjimo. Tikėtina: 30–50 % opus dispatch'ų →
sonnet ≈ −70…−100 $/13 d. **Tik po L1**: šiandien sonnet nesėkmės daugiausia yra lubos, ne
gebėjimas.

### L3 (P1) — vartų paleidimai: 66/d. × 3,5 min, kiekvienas — pilnas

`pnpm test` pagal dizainą yra VIENINTELIS vartas (CLAUDE.md, `gate-covers-ui-app.test.ts`) — tai
teisinga Stop'ui ir verify'ui. Bet tas pats pilnas paleidimas vyksta ir tarpiniams worker'io
patikrinimams. Svertai, nekeičiantys varto semantikos: (a) `tsc --build` inkrementinis build'as
hook'uose (dabar pilnas `tsc -p` kas kartą); (b) tarpinė worker'io Patikra — `pnpm test:only`
(build + node testai) be lint'o ir ui pakopos, kai `ui-app/` nepaliestas, pilnas — Stop'e;
(c) worktree kopijos su savo `dist` (yra) — bet `code-index was stale and was deterministically
rebuilt` **261 iš 275 dispatch'ų** (95 %): indeksas pertvarkomas beveik kas kartą, o jo trukmė
niekur neloginama. Pirmas žingsnis — išmatuoti. Tikėtina: −30…−50 % vartų laiko (≈ 1,5–2 h/d.).

### L4 (P2) — preflight LLM ir skėlimas: 26 skėlimai su VIENU vaiku

> PATAISA 2026-09-03 (modelių auditas): `preflight-llm.ts:74` — „pirmą įrašyk į `claude_task`,
> likusias į `child_tasks`", `enqueue-child-tasks.ts:313` `ordinal: index + 2`. **Tėvas YRA
> 1-a dalis, vaikai — 2…N.** Todėl „1 vaiko skėlimas" = skėlimas į DVI dalis, o tėvo dispatch'as
> po skėlimo yra dizainas, ne dubliavimas. Žemiau esantys teiginiai (a) ir (c) NEGALIOJA;
> lieka klausimas (b) — kodėl 8 kelių / 5 veiksmų / 75 eilučių task'as (154) gavo „split plan
> required": `exceedsLimits` ribos (8/6/2/120) 154 formaliai netenkina nė vienos. Atskiras
> patikrinimas prieš bet kokį task'ą.

LLM preflight'as: 101 verdiktai — 27 `delegate`, **74 `reformulate_delegate`**; `TASK SPLIT` 64
tėvai → 125 vaikai (26×1, 25×2, 8×3, 2×4, 1×5, 2×6). **Skėlimas į vieną vaiką nieko nelygiagretina
ir neapmoka nei preflight'o (≈ 0,5 $), nei papildomo dispatch'o.** Struktūrinės ribos
(`preflight-limits`: 8 kelių, 6 veiksmų, 2 domenai, 120 eilučių) sutampa su biudžeto `max_files: 8`,
tad kiekvienas ribose parašytas 8-kelių task'as jau yra „structurally large" (91 kartai).
Fastpath'as praleidžia LLM 178/279 (64 %).

Svertas: (a) 1 vaiko skėlimas = ne skėlimas (tėvas dispatch'inamas kaip yra); (b) „large" ne iš
kelių skaičiaus, kuris jau ribotas kitur; (c) tėvas po skėlimo NEdispatch'inamas dar kartą
(154: `TASK SPLIT queued_child_tasks=2` ir po 1 s `TASK DELEGATED TO CLAUDE: 154` — tėvas IR
vaikai). Tikėtina: −26 dispatch'ai, −30…−40 LLM preflight'ų ≈ −60…−80 $/13 d.

### L5 (P2) — autorystės klaidos kainuoja pilną dispatch'ą

Human-review 69: **`rollback_failed` 34** (darbas padarytas, diagnozė rado kelią už `## Failai` —
rollback'as atsisako naikinti užcommit'intą darbą → žmogus), `preflight_failed` 16 (pigu),
`preflight_retry_without_change` 7, `budget_enforcement_failed` 6. Integracijos parkai:
`task-failed` 56, `merge-conflict` 7, `merge-dirty-primary-tree` 7, `dist-rebuild-failed` 4.
≈ 55 iš 294 dispatch'ų (19 %) baigėsi nesėkme arba human-review → **≈ 95 $ ir 55 žmogaus
įsikišimai**. Didžioji dalis — task'o teksto klaidos, kurias deterministinės taisyklės pagautų
prieš dispatch'ą (etalono testų auditas 09-03: prozinės priklausomybės, anotacijos bloke, pasenę
keliai, pinantys testai). Tas auditas ir yra šio sverto planas.

### L6 (P2) — context cache: 2 hit'ai per 13 dienų

`cache_status`: **hit 2, miss 307**, unknown 96 (sintetinės eilutės). Raktas hash'uoja šaltinių
turinį, o šaltiniai (`## Failai` keliai) keičiasi su kiekvienu commit'u — hit'as galimas tik
re-dispatch'ui be pakeitimų. Kešo kaina: `CONTEXT_CACHE_VERSION` (10 pakėlimų), cache-sources
moduliai, 7 RAG auditai jo invariantams, `pnpm test` pin'ai. Nauda: 2 pack'ai. Svertas: arba
pripažinti, kad kešas yra „re-dispatch be pokyčių" atvejui ir sumažinti jo ceremonialą, arba
išmatuoti, kiek kainuoja miss'as (surinkimas + code-index), ir jei < 5 s — pašalinti.

### L7 (P3) — antro slot'o priežastis neįskaitoma

`granted=2/2` 10 vs `granted=1/2` 179. Eilėje dažnai stovi 1–2 task'ai (`single-candidate` 34) —
tai queue formos, ne planuoklės klausimas. Bet log'e dominuoja `missing-lease` (523) ir `hard-cap`
(471) — vidinės raundo būsenos, ne priežastys. Svertas: `WORKER POOL` eilutė pirmiausia vardija
PRIEŽASTĮ, kodėl antras slot'as tuščias (nėra kandidato / sankirta / priklausomybė), o
buhalteriją — po jos.

## Papildymas (tos pačios dienos antras praėjimas)

- **Kaštų koncentracija.** 24 dispatch'ai ≥ 4 $ (8 % dispatch'ų) ≈ 150 $ (≈ 30 % dispatch išlaidų).
  Visi keturi mobile paketo task'ai (117 — 11,8 $/118 turn'ų, 119, 120, 121 — 8,2 $/83) yra tarp
  jų: `mobile-*` `node_modules` sąmoningai neinstaliuoti → worker'is negali paleisti `pnpm
  test:mobile-*` ir tyrinėja ilgiau. Kompozicijos/wiring task'ai (029 — 12 $, 101-b-03 — 10,4 $,
  012-a-02 — 5,5 $) — antra brangi klasė.
- **Pakartotiniai ratai.** `task-events.jsonl`: 139 perėjimų į `human-review` prieš 179 į `done`
  (0,78 : 1). Tas pats task'as į human-review: 065 ×7, 012-a-02 ×7, 0001-audits-index ×5, dar
  penki ×3. `preflight_retry_without_change` 7. Requeue be teksto pakeitimo = tas pats parkas
  už tą pačią kainą; `accept-scope` (158) ir validatorius (156/157) taiko į tai.
- **Blokuoti bash kvietimai.** `hooks.log` (44,6 h): 91 `BLOCKED` — `sed` 12, `echo` 9, `dist`
  9, `git` 7, `cd` 5, `pnpm` variantai 3, `find` 3, `awk` 2. Kiekvienas blokas = sudegintas
  turn'as, o turn'ai yra ir kaina, ir lubos (L1). Read-only tekstų įrankių (`sed -n`, `awk`,
  `cut`, `echo`, `head -c`) allowlist'as be shell mutacijų nepakeistų saugumo, bet sumažintų
  tuščius turn'us. Dalis šių blokų — interaktyvios sesijos, ne worker'ių.
- **Converge drift.** `CONVERGE DRIFT: 32 issue(s) — 1 incomplete-work, 31 missing-task`
  paskutiniame cikle: 31 spec plano punktas be task'o — backlog'o, ne efektyvumo signalas,
  bet jį rodo tik log'as ciklo pabaigoje.

## Ko NEreikia optimizuoti

- **Prompt'o dydis** — pack'as 2–3 k tokenų prieš 1–15 M cache_read per dispatch'ą (kompresijos
  auditas). `compact_dsl`/`worker_task_ir` — trinti (task 155 kelias), ne tobulinti.
- **Diagnose** — 298 deterministiniai, 0 $.
- **Opus → sonnet aklai** — opus nesėkmių 3 %, sonnet 7,6 %; pirmiausia L1, tada L2 pagal kelius.

## Eiliškumas

| # | Svertas | Pastanga | Nauda / 13 d. |
|---|---|---|---|
| 1 | L1 medium lubos 60 → 90 | 1 konfigo eilutė + testas | −13 nesėkmių, −46 $, −40 vartų paleidimų |
| 2 | L4 vieno vaiko skėlimas = ne skėlimas; tėvas po skėlimo nedispatch'inamas | 1 task'as | −26 dispatch'ų, ≈ −60 $ |
| 3 | L5 etalono validatorius (atskiras auditas) | 2 task'ai | −30…−40 human-review, ≈ −60 $ |
| 4 | L2 klasifikacija iš kelių, ne žodžių | 1 task'as + kokybės stebėjimas | ≈ −70…−100 $ |
| 5 | L3 inkrementinis build + tarpinė siaura patikra; išmatuoti code-index rebuild | 2 task'ai | ≈ −1,5…−2 h/d. |
| 6 | L6 kešo verdiktas po matavimo | matavimas | mažiau ceremonialo |
| 7 | L7 pool log'o priežastis | 1 task'as | skaitomumas |

Bendrai 1–4: ≈ −40 % dispatch išlaidų ir ≈ −60 human-review įsikišimų per 13 dienų, be nė
vieno kokybės varto silpninimo.

Šaltiniai: `vq/config/token-budget.json`, `vq/config/task-classification-policy.json`,
`vq/config/preflight-limits.json`, `vq/config/context-budget.json`, `vq/logs/*` (grep skaičiai
audito metu), `docs/audits/compression-audit-2026-09-03.md`, `docs/audits/etalonas-tests-audit-2026-09-03.md`.
