# Modelių efektyvumo auditas — kas ką daro, kiek kainuoja ir kur pinigai virsta nesėkme

Data: 2026-09-03. Duomenys: `vq/logs/token-usage.jsonl` (306 dispatch'ai, 125 LLM preflight'ai),
`vq/logs/orchestrator.log` (`MODEL ROUTING`, `CLAUDE PREFLIGHT` eilutės, 08-21 → 09-03),
`vq/config/{model-policy,token-budget,task-classification-policy}.json`. Kaštai — kibirų
įverčiai (skriptai sandbox'e blokuoti), kryptys vienareikšmės. Pataiso 09-03 optimizavimo audito
L2 formuluotę: preflight eilutės `model=opus` yra biudžeto pakopa, ne vykdymo modelis.

## Kas realiai vykdo dispatch'us

| Modelis | Dispatch'ų | Sėkmė | Nesėkmė | Nesėkmė BE turn'ų lubų | Kaina (įv.) | Vid. / dispatch | Vid. / sėkmingą |
|---|---|---|---|---|---|---|---|
| claude-opus-5 | 68 (22 %) | 66 | 2 (2,9 %) | 1/67 (1,5 %) | ≈ 216 $ (42 %) | ≈ 3,2 $ | ≈ 3,3 $ |
| claude-sonnet-5 | 236 (77 %) | 218 | 18 (7,6 %) | 5/222 (2,3 %) | ≈ 290 $ (57 %) | ≈ 1,2 $ | ≈ 1,3 $ |
| claude-haiku-4-5 | 2 (1 %) | 1 | 1 | — | ≈ 0,5 $ | 0,25 $ | — |

Turn'ai: opus mediana ≈ 34, p75 ≈ 53, max 118; sonnet mediana ≈ 29, p75 ≈ 46, max 94. Output
tokenų pasiskirstymas beveik identiškas (opus: 19 < 10 k, 45 × 10–50 k, 4 × 50–100 k; sonnet: 88 /
124 / 13 / 2). Opus gauna sunkesnius task'us (klasifikacija `advanced`), tad tiesioginis
palyginimas neša atrankos šališkumą — bet nesėkmių skirtumas be lubų (1,5 % vs 2,3 %) yra
paklaidos ribose, o kaina už dispatch'ą — 2,6×.

Visi 12 dispatch'ų ≥ 5 $ yra opus. Sonnet niekada neperžengė 5 $.

## Kaip modelis parenkamas

`MODEL ROUTING` (283 eilutės):

| Kelias | Kiek | Modelis |
|---|---|---|
| `base=standard` explicit-selection | 194 | sonnet |
| `base=advanced` explicit-selection (klasifikacija `high`) | 55 | **opus** |
| repair, `failed_attempts=1`, defer | 10 | sonnet (ta pati pakopa) |
| source-change | 12 | sonnet |
| `selected=haiku`, bet `base=standard` → pakeliama | 6 (+10 repair) | sonnet |
| `routine-default` | 3 | haiku |
| `risk-signals` | 1 | opus |
| eskalacija `failed_attempts=2` | 1 | opus |

Išvados: (1) opus atsiranda TIK iš klasifikacijos `advanced` (55 iš 57) — t. y. iš raktažodžių
`policy`/`dependency`/`boundary`/`approval`/`architecture`, kurie šiame projekte yra kasdienė
kalba; (2) **haiku pakopa praktiškai negyva** — 16 kartų preflight'as ją pasirinko, 16 kartų
routing'as pakėlė iki sonnet, nes bazinė pakopa `standard`; realiai haiku dirbo 3 kartus
(kategorija `routine` — `docs/`, `tests/`, `README.md`); (3) `fable` pakopa deklaruota
`model-policy.json`, niekada nenaudota.

## Kur modelio darbas virsta nesėkme — ir tai ne modelis

### R1 (P1) — turn'ų lubos gamina 87 % sonnet nesėkmių

`token-budget.json turnLimits.medium: 60`. Sonnet: **14 iš 18 nesėkmių baigė tiksliai 61 turn'u.**
Be jų sonnet nesėkmė 2,3 % — tokia pati kaip opus. Opus lubų (large 180) nė vienas nepasiekė;
vienintelis opus 61-turn'ų atvejis buvo medium pakopos eskalacija (žr. R2).

### R2 (P1) — repair lubos (30) yra VISŲ repair nesėkmių priežastis

14 pakartotinių bandymų (`attempt ≥ 2`): 10 sėkmingi, 4 nesėkmingi. **Visi 4 nesėkmingi baigė
ties lubomis**: 31, 31, 31 turn'ai (repair 30) ir 61 (medium 60). Nė vieno repair'o nenukirto
lubos ir jis nepavyko — 10 iš 10. Repair'as, kuriam leista baigti, baigia.

### R3 (P1) — eskalacijos politika suveikė vieną kartą ir buvo iššvaistyta lubų

`escalation.on_retry: true, defer_steps: 1` — eskaluojama nuo antros nesėkmės. Per 13 dienų
vienintelė eskalacija: task 030, 3-ias bandymas, opus, **nukirstas ties 61 turn'u**, 4,4 $, failed.
Politika, kurios paskirtis — duoti stipresnį modelį sunkiam atvejui, davė jį su medium biudžetu.
Eskaluota pakopa turi paveldėti ir eskaluotą turn'ų biudžetą; kitaip ji kainuoja opus kainą už
sonnet lubas.

### R4 (P2) — preflight LLM sukasi opus'e be priežasties

125 LLM preflight'ai: **opus 85 (≈ 47 $), sonnet 40 (≈ 12 $)**. `claude-preflight/index.ts:248-249`:
preflight'o modelis = biudžeto pakopos modelis — struktūriškai didelis task'as gauna opus
REFORMULAVIMĄ. Reformulavimas, sekcijų normalizavimas ir skėlimo planas nėra opus lygio darbas;
opus preflight'ai kainuoja 0,5–0,95 $, sonnet — ≤ 0,44 $. Verdiktų pasiskirstymas pagal
pasirinktą vykdymo modelį: sonnet 87, opus 9, haiku 5 — t. y. opus preflight'as 90 % atvejų
nusprendžia, kad vykdyti gali sonnet. Svertas: preflight'ui fiksuotas sonnet → ≈ −20 $/13 d.
be jokios kokybės kainos, kurią būtų galima išmatuoti.

### R5 (P2) — opus pasirinkimas remiasi žodžiais, ne įrodymais

Opus kainuoja 2,6× už dispatch'ą ir dengia 42 % išlaidų; jo pranašumas nesėkmėse be lubų —
0,8 procentinio punkto su n=68. Tai per mažai, kad pateisintų 57 klasifikacinių opus dispatch'ų,
ir per daug netikra, kad opus atsisakyti. Teisingas kelias — matavimas, ne sprendimas:
`advanced` be KELIO signalo (`/auth/`, `migrations/`, `security-policy.json`) startuoja sonnet'u
su `defer_steps: 0` (eskalacija po pirmos nesėkmės, su paveldėtu large biudžetu). Po 2 savaičių
palyginti nesėkmes ir kainą už sėkmingą task'ą. Tikėtina riba: 30–50 % opus dispatch'ų → sonnet
≈ −60…−100 $/13 d. **Tik po R1–R3**, kitaip sonnet nesėkmės augs dėl lubų, ne dėl gebėjimo.

### R6 (P3) — haiku 4.5 nenaudojama ten, kur pigiausia

Kategorija `routine` (`docs/`, `tests/`, `README.md`, `i18n`) suveikė 3 kartus iš ~300; 2 su usage:
013 sėkmė 0,32 $ / 31 turn'as, 007 nesėkmė 0,19 $. Imtis nieko nesako. Šiame korpuse yra dešimtys
task'ų, kurie yra grynai i18n eilutės, README lentelės, puslapių pavadinimai (107-*, 108, 110) — jie
sonnet'e kainavo 0,2–0,5 $. Kontroliuojamas bandymas: `routine` klasifikacija pagal kelius
`ui-app/src/i18n/`, `docs/`, `README.md` → haiku 2 savaites; kriterijus — nesėkmių dalis ≤ sonnet.
Tikėtinas efektas mažas (≈ −10 $/13 d.), rizika maža, žinios — realios.

## Ko modeliai NEkainuoja

- Diagnose: 298 deterministinių sprendimų, 0 $ — teisingas dizainas.
- Fastpath preflight: 178 iš 279 (64 %) be LLM.
- Prompt caching veikia: `cache_creation` 28–232 k prieš `cache_read` 0,1–15,6 M per dispatch'ą
  (> 95 % skaitymų iš kešo) abiem modeliams.

## Verdiktas

Modeliai patys yra efektyvūs: opus rezervuotas 22 % dispatch'ų, sonnet nesėkmės be lubų 2,3 %,
kešas veikia, diagnostika nemokama. **Neefektyvumas yra aplink modelius:** turn'ų lubos paverčia
17 beveik baigtų runų nesėkmėmis (14 sonnet + 3 repair), vienintelė eskalacija iššvaistyta tų pačių
lubų, preflight'as be reikalo sukasi brangiausiu modeliu, o pigiausia pakopa neturi kelio iki darbo.

## Eiliškumas

| # | Veiksmas | Kur | Nauda / 13 d. |
|---|---|---|---|
| 1 | `medium` 60 → 90, `repair` 30 → 45 | `token-budget.json` + pinantis testas | −17 nesėkmių, ≈ −55 $ |
| 2 | Eskaluota pakopa paveldi `large` turn'ų biudžetą | routing / dispatch biudžeto sprendimas | eskalacija nustoja būti savižudiška |
| 3 | Preflight LLM — sonnet visada | `claude-preflight/index.ts:248` | ≈ −20 $ |
| 4 | `advanced` tik iš kelių; `defer_steps: 0` be kelio signalo — 2 sav. matavimas | klasifikacijos politika + `model-policy.json` | ≈ −60…−100 $, jei kokybė laikosi |
| 5 | `routine` → haiku pagal kelius, 2 sav. bandymas | klasifikacijos politika | ≈ −10 $, žinios |

Šaltiniai: `vq/logs/token-usage.jsonl`, `vq/logs/orchestrator.log`, `vq/config/model-policy.json`,
`vq/config/token-budget.json`, `vq/config/task-classification-policy.json`,
`src/interfaces/cli/dispatch/claude-preflight/index.ts:248-258`,
`docs/audits/optimization-audit-2026-09-03.md` (L1/L2), `docs/audits/compression-audit-2026-09-03.md` (§2).
