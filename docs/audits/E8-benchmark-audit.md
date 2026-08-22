# Benchmark auditas prieš mokamą bėgimą (VQ-802)

**Data:** 2026-08-22 · **Kaina:** 4 mokamos celės (3 `agent-solo` zondo + 1 `benchmark-drive`)
**Klausimas:** ar 144 celių bėgimas duotų patikimą verdiktą?

## Verdiktas

**NE — ne tokį, kokį VQ-802 aprašo.** Harness'as sveikas ir palyginamumo vartai atsivertų, bet
**užšaldyti AG_loop baseline dokumentai neturi NĖ VIENO kaštų matavimo**, o `agent-solo` režimas
šiandien apskritai negali pagaminti kaštų įrašo. Bėgimas būtų davęs VERQESTRA skaičius, kuriems
nėra su kuo lygintis, ir 72 tuščias celes.

Būtent tam auditas ir buvo: šis atsakymas kainavo 4 celes vietoj 144.

## Ką patikrinau ir kas ŽALIA

### 1. Palyginamumo vartai atsivertų

`benchmark baseline create` prieš dabartinį medį ir palyginimas su
`baselines/2026-08-10-bb566c6f6bb8.json`. VISI privalomi metodologijos laukai sutampa **tiksliai**:

| Laukas | Baseline | Dabar |
|---|---|---|
| `identity.suiteHash` | `sha256:bb566c6f…` | **sutampa** |
| `suiteVersion` | `1.0.0` | **sutampa** |
| `identity.configHash` | `sha256:96635102…` | **sutampa** |
| `identity.policyHash` | `sha256:608c0773…` | **sutampa** |
| `modelSettings.model` | `claude-opus-5` | **sutampa** |
| `verifierVersion` | `independent-acceptance/1` | **sutampa** |
| `modeAdapterVersions` (×3) | `ag-loop/2`, `agent-solo/2`, `deterministic-control/1` | **sutampa** |
| `identity.agCommit` | `aecfa861…` | skiriasi — **taip ir turi būti** (tai matuojamas dalykas; advisory, ne atmetimas) |

`benchmark compare` realiai įvykdytas: **24 scenarijai palyginti**, verdiktas `stable`. Vartai
atsivėrė, mechanizmas veikia nuo baseline skaitymo iki verdikto.

### 2. `ag-loop` telemetrija veikia

`benchmark-drive` paleistas prieš laikiną git kopiją ir grąžino galiojantį voką:

```json
{"agBenchmarkTelemetry":2,"model":"claude-sonnet-5","inputTokens":2,"outputTokens":3,
 "llmCalls":1,"attempts":1,"repairs":0,"humanReviewEvents":0,"claimedDone":true,
 "usage":{"captured":true,"cacheReadInputTokens":29630,"cacheCreationInputTokens":9339,
 "numTurns":1,"turnsSource":"recorded"}}
```

Argumentų kontraktas (`--workdir`, `--model`, `--step-limit`, `--timeout-ms`, promptas per stdin)
sutampa su invocation šablonu byte į baitą.

### 3. Vartai atsisako dar nepradėję leisti pinigų

Bandymas `--repetitions 1` atmestas: BENCH-9 reikalauja ≥3 pakartojimų nedeterministiniams
scenarijams. Atmetimas atėjo kaip planas, ne kaip klaida po apmokėtos celės.

## Ką patikrinau ir kas RAUDONA

### R1 — Baseline'uose NĖRA kaštų duomenų

```text
2026-08-09-bb566c6f6bb8.json : 72 sample'ai, VISI deterministic-control, 0 su token telemetrija
2026-08-10-bb566c6f6bb8.json : 72 sample'ai, VISI deterministic-control, 0 su token telemetrija
```

VQ-802 formuluotė yra „tokens/verified-change VERQESTRA vs AG_loop baseline (VQ-001)". Tokio
palyginimo padaryti neįmanoma: baseline'as niekada nematavo nė vieno token'o. Ankstesnis
`compare` verdiktas `stable` yra teisingas, bet jis lygina `deterministic-control` su
`deterministic-control` — apie kaštus jis nesako nieko.

### R2 — `agent-solo` režimas negali pagaminti kaštų įrašo

Trys celės, trys tokie patys atsakymai:

```text
no-cost-record: telemetry-missing: the agent printed no telemetry envelope
samples: 0 — the run produced no sample, so it measured nothing
```

Priežastis struktūrinė: `agent-solo` kviečia `claude --print …` tiesiogiai, o telemetrijos voką
spausdina tik `benchmark-drive`. Paketo shipped šablonas tokio draiverio neturi.

**Tai NE VERQESTRA regresija** — etalono tiltas (`interfaces/cli/benchmark/index.ts`) daro
lygiai tą patį: `{ ...DEFAULT_AGENT_INVOCATION_CONFIG, "ag-loop": <template> }`. Tai paaiškina ir
R1: baseline'uose nėra `agent-solo` sample'ų, nes jų niekada ir negalėjo būti.

### R3 — įrankių versijos neužfiksuojamos, kai paleidžiama ne per pnpm

`pnpm` versija skaitoma iš `npm_config_user_agent`, kurį nustato pati pnpm. Paleidus
`node dist/cli.js benchmark …` tiesiogiai, ji lieka `unavailable` ir palyginimas neša
nereikalingą apribojimą. Patikrinta: per `pnpm exec` — `pnpm/9.15.9 …`.

**Rekomendacija:** mokamą bėgimą leisti per `pnpm exec`.

## Ką operatorius realiai gali pasirinkti

| Variantas | Ką duoda | Kaina | Kas pirma |
|---|---|---|---|
| **A. Vidinis palyginimas** | atsako į paties produkto klausimą: kiek kainuoja loop'as prieš TĄ PATĮ agentą be loop'o | 144 celės | reikia `agent-solo` draiverio, kuris spausdina voką (R2) |
| **B. Pirmas VERQESTRA kaštų baseline** | 72 `ag-loop` celės užantspauduojamos kaip atskaitos taškas ateičiai; palyginimo nėra | 72 celės | nieko — veikia šiandien |
| **C. Nedaryti** | VQ-802 lieka atviras su užrašyta priežastimi | 0 | nieko |

Variantas A yra tas, kurį aprašo paketo README („Measures what VERQESTRA actually costs and
delivers, against the same agent running without it"). Jam reikia vieno naujo dalyko: `agent-solo`
celės draiverio, kuris paleidžia `claude` ir išspausdina tą patį `agBenchmarkTelemetry` voką.
Tai to paties dydžio darbas kaip esamas `benchmark-drive`, tik be loop'o.

## Ko šis auditas nedarė

- Neleido nė vienos `ag-loop` celės per patį benchmark harness'ą (tik `benchmark-drive`
  tiesiogiai). Pirmas toks bėgimas kainuotų ≥3 celes dėl BENCH-9.
- Nekeitė nė vieno baseline dokumento. Baseline yra nekintamas pagal apibrėžimą.
