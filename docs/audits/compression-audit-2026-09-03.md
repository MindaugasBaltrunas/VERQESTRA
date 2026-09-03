# Kompresoriaus auditas 3 — ar jis ką nors spaudžia ir ar jis reikalingas

Data: 2026-09-03. Klausimas iš operatoriaus: „ar kompresorius ką nors spaudžia, ar jis
reikalingas?" Atsakymas duomenimis iš gyvo runtime (`vq/logs/context-size.jsonl` — 403 įrašai,
`vq/logs/token-usage.jsonl` — 922 įrašai, 293 dispatch'ai su usage), konfigo, arrest markerio ir
kodo. Ankstesni auditai: 2026-08-29 (1) ir 2026-09-01 (2) — abu baigėsi išvada „naudos klausimas
neatsakomas, kol telemetrija sugadinta". Šis auditas atsako, kiek atsakyti galima, ir įvardija,
kodėl likusi dalis vis dar neatsakoma.

## Konfigūracija audito metu

```json
"worker_task_ir": false, "compact_dsl": false, "bash_output_digest": false,
"symbol_slices": "canary", "dispatch_tool_schema": "canary",   // canary 30 %, salt v1
```

Arrest markeris: `arrests: []`, `fallback_streak.compact_dsl: 2`, `human_review: {}`. Niekas
neareštuota.

## 1. Ką kiekviena feature realiai daro su dydžiu

### `compact_dsl` + `worker_task_ir` — PADIDINA, 204 iš 204

Shadow pora `raw_prompt_chars` / `compiled_prompt_chars` rašoma kiekvienam dispatch'ui, nors
feature išjungta. **Visuose 204 matavimuose kompiliuotas prompt'as yra DIDESNIS už žalią**:
nuo +3,4 % (11 577 → 11 967) iki +15,4 % (6 313 → 7 285), tipiškai +5–10 %. Nė vieno atvejo,
kur būtų mažesnis. Kai feature buvo `canary` (2026-08-28/29), size guard'as 4 iš 4 canary
dispatch'ų nusiuntė `size-fallback` keliu — iš čia `fallback_streak: 2`.

Klausimas apie šias dvi feature'es yra **uždarytas duomenimis**: preambulė ir IR struktūra
kainuoja daugiau, nei sutaupo, visame šio projekto task'ų korpuse. Kas lieka gyva — dviguba
kompiliacija kiekvienam dispatch'ui vien tam, kad įrašytų porą, kurios atsakymas jau žinomas.

### `symbol_slices` — NE kompresija, o PRATURTINIMAS (+50 % pack'o)

Kodas (`assemble/gather.ts:60-63`, `tiers.ts:101-107`): su feature išjungta „contract selection
is 0 and no slice is ever read" — control pack'as neša tik simbolių parašus (SIG). Su feature
įjungta pridedamos REF/SIG/SRC kopėčios: dalis simbolių gauna pilną šaltinio pjūvį (SRC, iki
`max_symbol_source_chars: 3000`) ir kontraktų parašus.

Gyvi dydžiai (`context_chars`), tik 2026-09-02/03, kad būtų sąžininga laike:

| Kohorta | n | Diapazonas | Mediana |
|---|---|---|---|
| control (be `canary_features`) | 25 | 6 418 – 9 003 | ≈ 7 100 |
| canary (`symbol_slices`) | 15 | 9 642 – 11 969 | ≈ 10 900 |

Visame žurnale: 32 iš 36 canary pack'ų ≥ 9 600 simbolių; iš ~268 control pack'ų virš 10 000 yra
3. Canary pack'ai stovi prie `max_context_chars: 12000` lubų. Tai priešinga kompresijai.

UI rodoma pora `symbol_source_chars` / `symbol_signature_chars` (Σ 273 459 vs Σ 17 404 per
27 matavimus, „−94 %") lygina SIG su **hipotetiniu nekarpytu SRC**, kurio control'as niekada
nesiuntė (`persist.ts:132` — `measured + symbol_hypothetical_src_chars`). Tai nėra sutaupymas
prieš control'ą; tai skaičius, kiek DAUGIAU būtų kainavę siųsti viską. Dashboard'e jis skaitomas
kaip kompresijos nauda — ir yra klaidinantis.

Vienintelė teisėta `symbol_slices` hipotezė: turtingesnis kontekstas → mažiau turn'ų → pigiau ir
mažiau human-review. Tai KOKYBĖS, ne dydžio eksperimentas, ir jį matuoti gali tik kohortų
palyginimas (`turnsP50`, `billableTokensP50`, `humanReviewRate`). Žr. §3, kodėl jis šiandien
nieko nematuoja.

### `dispatch_tool_schema` — veikia, bet niekada neišmatuota

34 dispatch'ai `"applied"` (`tools_offered: 25`) prieš 271 `"off"` (27 arba 29). Dviejų–keturių
įrankių schemos mažiau kiekviename turn'e. Shadow pora `tool_schema_full_chars` /
`tool_schema_reduced_chars`, kurią `claude-dispatch-finalize.ts:144-160` rašo, kai
`input.toolSchema.shadow` egzistuoja: **0 įrašų visame žurnale**. Shadow niekada nepaduodamas.
(Auditas 2, radinys #152 — patvirtintas, neuždarytas.)

### `bash_output_digest` — vienintelė feature, nukreipta į tikrą kaštą, ir ji išjungta

Shadow pora `tool_raw_chars` / `tool_digest_chars`: **0 įrašų**. Niekada nematuota. Canary jai
neįmanomas pagal dizainą (`CONTEXT_COMPRESSION_CANARY_UNSUPPORTED`).

## 2. Kur iš tikrųjų eina tokenai

Paskutiniai 40 dispatch'ų su usage (`token-usage.jsonl`, `phase: dispatch`):

| Laukas | Min | Max | Tipiškai |
|---|---|---|---|
| `cache_read_input_tokens` | 132 869 | 15 571 016 | 1–6 M |
| `cache_creation_input_tokens` | 28 463 | 231 934 | 70–150 k |
| `num_turns` | 4 | 118 | 30–60 |
| `total_cost_usd` | 0,21 | 11,83 | 1–5 |

Context pack'as yra 7–12 k simbolių ≈ 2–3 k tokenų. Tai **< 2 % `cache_creation`** ir
**< 0,05 % `cache_read`** vieno dispatch'o. Kaina koreliuoja su turn'ų skaičiumi (4 turn'ai →
0,21 $; 105 turn'ai → 10,47 $), ne su pradinio prompt'o dydžiu. Suspaudus pack'ą iki nulio,
sąskaita pasikeistų paklaidos ribose.

Išvada: **kompresorius optimizuoja kintamąjį, kuris nelemia kaštų.** Kaštus lemia sesijos
ilgis ir įrankių išvestis per turn'us — būtent ta sritis, kurią dengia vienintelė išjungta ir
nematuojama feature.

## 3. Kodėl A/B eksperimentas per 6 dienas nesurinko NĖ VIENO galiojančio canary stebėjimo

Kiekvienam canary task'ui žurnale yra dvi eilutės: pack'o eilutė su `canary_features` ir
vėlesnė `claude-dispatch-finalize.ts:167-186` eilutė (`worker_prompt_chars`, `context_chars: 0`)
**be** `canary_features`. Skaitytojai (`attempt-identity-join.ts:130-151 assignArms`,
`worker-prompt-preparation.ts:59-69`) taiko „vėliausias laimi" — tuščias masyvas reiškia
control. Patikrinta visiems 34 užbaigtiems canary task'ams: **34 iš 34 demotuoti į control**.
Vienintelis task'as, kurį raportas šiandien laiko canary, yra 121 — jis dar vykdomas.

Pasekmės:
- kohortų raportas: canary `n ≈ 0–1` → `insufficientSample` amžinai; control kohorta užteršta
  visais canary task'ais;
- K trigger'is (human-review arrest) miręs visiems užbaigtiems dispatch'ams — arrest'as
  `human_review: {}` yra ne „viskas gerai", o „skaitiklis nemato";
- `symbol_slices` kokybės hipotezė (§1) yra NEPATIKRINAMA dabartiniu žurnalu.

Tai auditas 2 radinys P1. Atmintyje jis buvo įrašytas kaip „task'ai 148–152 queue" — **tie
numeriai atiteko kitiems task'ams** (infra abort, YAML frontmatter, allowed-paths, write-policy,
restored slot). Kompresijos P1/P2 (finalize eilutės be features, arrest observer'io
read-modify-write be lock'o `compression-arrest-observer.ts:46-54`, per-feature atribucijos
nebuvimas, tool-schema shadow) **task'ų neturi**. Grep per `AG/tasks/**` pagal
`latest-wins|lost-update|fallback_streak` — tuščias.

## 4. Kaina išlaikyti

Produkcinis kodas (be testų): domain/policies/compression 759, context-pack kompresijos moduliai
(policy, observer, attribution, tiers, cache-sources) 818, compact-dsl + worker-task-ir +
prompt-compilation + source-slice 1 954, analytics kohortos 1 076, release-readiness 905,
HTTP/UI 550 + dispatch prompt-preparation 243, ui-app puslapis + panelė 569 — **≈ 6 900
eilučių**. Testų bent 2 110 eilučių (dalinis sąrašas). Kiekviename dispatch'e: dviguba prompt'o
kompiliacija shadow porai, arrest markerio skaitymas/rašymas, canary hash'as.

`final-audit` per `checkCompressionQuality` tikrina, ar `true` vėliavos turi įrodymų — šiandien
`true` vėliavų nėra, tad vartas inertiškas.

## Verdiktas

| Klausimas | Atsakymas |
|---|---|
| Ar jis ką nors spaudžia? | **Ne.** `compact_dsl`/`worker_task_ir` didina (204/204). `symbol_slices` didina pack'ą ~50 %. `dispatch_tool_schema` mažina 2–4 įrankių schemas — nematuota. `bash_output_digest` — išjungta, nematuota. |
| Ar jis reikalingas kaip kaštų mažinimo priemonė? | **Ne.** Pack'as < 0,05 % sesijos tokenų. |
| Ar jis reikalingas kaip eksperimentų platforma? | **Šiandien negali atsakyti į savo klausimą** — 34/34 canary stebėjimai demotuoti. |
| Kas vertingo lieka? | `symbol_slices` kaip **konteksto kokybės** eksperimentas (mažiau turn'ų?) — bet tik su pataisyta telemetrija. `bash_output_digest` — vienintelė kryptis, kur kompresija paliestų tikrą kaštą. |

## Rekomendacija (eiliškumas svarbus)

1. **Pataisyti demotavimą** (1 mažas task'as): finalize/hook sintetinės eilutės arba nerašo į
   `context-size.jsonl`, arba nešasi to paties dispatch'o `canary_features`; skaitytojai
   ignoruoja `context_chars: 0` eilutes arm'o sprendimui. Be to nė vienas kitas sprendimas
   neturi duomenų.
2. **Pašalinti `compact_dsl` + `worker_task_ir` ir jų shadow matavimą** (~1 950 LOC + 2 dviguba
   kompiliacija per dispatch'ą). Klausimas uždarytas 204/204.
3. **Pervadinti `symbol_slices` iš „kompresijos" į „konteksto praturtinimą"** UI ir doc'uose;
   pašalinti klaidinančią `symbol_source_chars` „−94 %" porą arba lyginti su control'o
   `context_chars`. Po 1 žingsnio duoti 2 savaites canary ir spręsti pagal `turnsP50` /
   `humanReviewRate`, ne pagal dydį.
4. **`dispatch_tool_schema`**: prijungti shadow (arba nustoti žadėti porą). Nauda maža, bet reali
   ir neutrali kokybei — kandidatė į `true`, kai bus skaičius.
5. **`bash_output_digest`**: jei kompresijos programa tęsiama, tai vienintelė jos vieta.
   Kitu atveju — pripažinti, kad programa buvo nukreipta į prompt'o dydį, o ne į sesijos kaštą,
   ir ją uždaryti po 1–3 žingsnių.

Šaltiniai: `vq/logs/context-size.jsonl`, `vq/logs/token-usage.jsonl`, `vq/config/context-compression.json`,
`vq/state/context-compression-arrest.json`, `src/application/context-pack/assemble/{tiers,gather,persist}.ts`,
`src/application/context-pack/metrics.ts:259-280`, `src/application/analytics/attempt-identity-join.ts:100-151`,
`src/infrastructure/adapters/claude-dispatch-finalize.ts:144-186`, `src/application/context-pack/compression-arrest-observer.ts`.
