# Etalono testų auditas — ką `000-etalonas.md` deklaruoja ir ką vartai tikrina

Data: 2026-09-03. Klausimas: ar etalono (`AG/tasks/examples/000-etalonas.md`) taisyklės yra
vykdomos, ar tik užrašytos. Kontekstas: per dvi paras (09-02/03) trys task'ai (101-b-03,
137-a-02, 141-b-03) parkavosi ar blokavo bangą dėl `## Failai`/`## Priklausomybės` turinio, kurį
etalonas draudžia žodžiu, o nė vienas validatorius nemato.

## Kas egzistuoja

| Sluoksnis | Kur | Kada veikia | Taisyklės |
|---|---|---|---|
| Domain validatorius | `src/domain/tasks/etalonas-rules.ts` `validateTaskAgainstEtalonas` | TIK pre-write hook'as (`interfaces/hooks/pre-hooks.ts:233`) — interaktyvus rašymas per Write/Edit | sekcijų buvimas + tvarka; wildcard be pagrindimo (`**` arba `/` gale); Priklausomybių placeholder + nežinomas id (tik id formos); Patikra — 3 tikslios komandos |
| Preflight taisyklės | `src/application/quality-gates/preflight-fastpath.ts` `evaluateEtalonasRuleViolations` | Loop'o preflight (`claude-preflight/preflight-validate.ts:62`) | wildcard (`^(**\|.+/**)$`); produkcinis failas be testo (silpna: vienas testas dengia visus); UI be I18nContext / be `view/styles/*.css`; Patikra be backtick'o; placeholder (savas token'ų sąrašas) |
| Testai | `task-etalonas-sync.test.ts` (antraštės ↔ parseris), `domain-tasks-etalonas-rules.test.ts` (4 taisyklės), `quality-gates-preflight.test.ts:479` (6 taisyklės + VISI `AG/tasks/queue/*.md`) | `pnpm test` | — |

`etalonas-rules.ts:1-3` antraštė teigia: „the pre-write hook and the 070 preflight gate both
import `validateTaskAgainstEtalonas` instead of keeping their own copy". **Netiesa** — grep
rodo vienintelį produkcinį importą (`pre-hooks.ts:30`); preflight turi SAVO kopiją su kitokiu
taisyklių rinkiniu. Tai būtent tas dubliavimas, kurį antraštė skelbia panaikinusi.

## Radiniai

### R1 (P1) — du validatoriai, tas pats etalonas, skirtingi verdiktai

| Taisyklė | Hook (domain) | Loop (preflight) |
|---|---|---|
| Sekcijų tvarka | tikrina | ne |
| `## Neįtraukta` | privaloma (buvimas) | neprivaloma |
| Wildcard | `**` arba `xxx/` | tik `**` formos |
| `## Patikra` | tik `pnpm build`/`pnpm test`/`pnpm --dir ui-app build` | bet kuri backtick komanda |
| Priklausomybė nežinomas id | tikrina | ne |
| Produkcinis failas be testo | ne | tikrina |
| UI I18nContext/CSS | ne | tikrina |

Generatoriaus (`task-planning/generate.ts`) rašomi failai hook'o NEPEREINA (fs, ne Write tool),
tad jiems galioja tik silpnesnis rinkinys: `pnpm typecheck` `## Patikra` sekcijoje praeina
preflight'ą ir paverčia `pnpm test` raudonu VISIEMS (žinomas incidentas, atmintyje
`verqestra-patikra-command-allowlist`). Interaktyviai parašytas task'as tikrinamas griežčiau nei
automatinis — atvirkščiai, nei turėtų būti.

### R2 (P1) — prozinė priklausomybė praeina abu validatorius

Etalonas: „arba tikras id, arba sekcijos nėra". Domain `checkPriklausomybes` tikrina tik
placeholder'ius ir `TASK_ID_SHAPE` (`/^[0-9]{2,4}(-[a-z0-9]+)+$/`) atitinkančius; visa kita
„left alone". Preflight — tik placeholder'ius. Tad `- 137 pirmoji dalis: in-flight išvedimas…`
ar `- 141-b — dispositions…` (didžiosios raidės, tarpai, brūkšnys) nėra nei placeholder, nei
id → nulis pažeidimų → planuoklė `missing-dependency` → `LOOP STOP: all-blocked`.
`orchestrator.log`: 16 `gate:missing-dependency<-` eilučių 08-29…09-03; 09-51 sustojo visa banga.

### R3 (P1) — trys `## Failai` skaitytojai, trys skaičiai

Vienas blokas, trys vartai, trys atsakymai tam pačiam task'ui (101-b-03, 12:27):

| Skaitytojas | Kaip skaičiuoja | Rezultatas | Riba |
|---|---|---|---|
| `domain/tasks/size.ts:132` (preflight size gate) | `allowedPaths` + `isPathShapedToken` filtras | 8 → „size within limits" | `preflight-limits.maxAllowedPaths: 8` |
| `preflight-rules.ts:447` (policy advisory) | `allowedFiles.length` | 11 → „advisory 11 > 10" | `architecture-policies max_files_per_task: 10` |
| `tool-budget-gates.ts:150` (hard) | `contextPack.allowed_paths.length` (nefiltruotas) | 11 → **parkas** | `context-budget.max_files: 8` |

Skirtumą (3) padarė `> …` anotacija TARP `Leidžiama:` ir `Draudžiama:`: kanoninis
`allowed-paths.ts:92-98` ne-bullet eilutėje ima VISUS backtick tokenus, tad `09:26:11`,
`changed files outside allowed paths`, `CONTEXT_CACHE_VERSION` tapo „keliais". Domain
validatoriaus `leidziamaBulletLines` ima TIK bullet'us — jis šitų trijų net nemato, tad
negalėtų perspėti. Preflight LLM to nematė irgi: fastpath'as pasakė „task already canonical"
ir LLM buvo praleistas. Deterministinės taisyklės šiam task'ui buvo VIENINTELIS vartas.

### R4 (P2) — etalono taisyklės be jokio vykdytojo

| Etalono taisyklė | Kaina, kai pažeista | Kas tikrina |
|---|---|---|
| Failai (2): KIEKVIENAS produkcinis failas su savo testu | diagnozė „outside allowed paths" (task 138 pinantys testai) | preflight tikrina tik „bent vienas testas" |
| Failai (9): `CONTEXT_CACHE_VERSION` → `context-pack-guards.test.ts` + `context-pack-code-index-identity.test.ts` | parkas po rollback'o (138, 2026-09-02) | niekas — deterministinė, pigi |
| Tas pats kelias `Leidžiama` IR `Draudžiama` | dviprasmybė vykdytojui (101-b-03 turėjo) | niekas |
| Keliai turi egzistuoti (Glob prieš deklaruojant) | 137-a-02 parkas (pertvarkyti ui-app keliai), 5 parkai 08-28 | niekas — preflight yra CLI su FS, galėtų; „numatomas naujas" išlyga skliaustuose leidžia atskirti |
| `## Neįtraukta` „bent viena eilutė" | „neapgalvota apimtis" | niekas — abu tikrina tik buvimą / neprivaloma |
| `## Agentai` prasideda `readme-guard` | grandinė be ribų sargo | fastpath tikrina tik „žinomi agentai" |
| `HUMAN-REVIEW-APPROVED` „tuoj po `# Task`" | — | `gates.ts:45` regex priima bet kurioje eilutėje (`m`) — spec ir kodas nesutampa, parkų nesukėlė |

### R5 (P2) — testų sluoksnis nesaugo nuo drifto

- `task-etalonas-sync` pina antraščių sąrašą, bet ne taisyklių inventorių: etalono `> 1.…9.`
  punktai keičiami tekstu (šiandien — `dashboard.css` skaidymo pastaba), o validatoriaus
  keisti niekas neverčia. `dashboard.css` atvejį pagavo tik 2026-09-03 parkas, ne testas.
- Realaus korpuso testas (`queue/*.md`) bėga TIK preflight rinkiniui; domain validatoriui
  korpuso testo nėra, tad task'as, praeinantis loop'ą, bet krentantis hook'e (arba
  atvirkščiai) lieka nematomas iki incidento.
- Nė vienas testas neteigia, kad du validatoriai sutaria (arba kad vienas yra kito viršaibis).
- `domain-tasks-etalonas-rules.test.ts` antraštė: „kiekvienai taisyklei po blokavimo ir
  praėjimo atvejį" — dengia 4 iš ~15 etalono teiginių.

## Verdiktas

Etalonas yra gerai parašytas dokumentas, kurio **daugumą taisyklių vykdo tik skaitantis
žmogus**. Dvi kodo kopijos vykdo skirtingus jo poaibius; loop'ui (kur task'ai realiai
vykdomi) galioja silpnesnė. Trys 09-02/03 parkai kilo iš trijų neprižiūrimų taisyklių
(prozinė priklausomybė, anotacija bloke, pasenę keliai) — ir kiekvieną iš jų galima
patikrinti deterministiškai, be LLM.

## Rekomendacija

1. **Vienas validatorius.** Šešias preflight taisykles perkelti į `domain/tasks/etalonas-rules.ts`
   (jos grynos), `preflight-fastpath.ts` kviečia jį per esamą tiltą. Antraštės teiginys tampa
   tiesa; rule id lieka stabilūs.
2. **Naujos deterministinės taisyklės** tame pačiame validatoriuje: (a) `## Priklausomybės`
   bullet'as, kuris nėra žinomas id, — pažeidimas (išimtis tik `<…>` šablonui); (b) ne-bullet
   eilutė su backtick'ais tarp `Leidžiama:` ir `Draudžiama:`; (c) `Leidžiama ∩ Draudžiama ≠ ∅`;
   (d) `## Neįtraukta` tuščias kūnas; (e) `CONTEXT_CACHE_VERSION` `## Veiksmas` tekste be dviejų
   pinančių testų sąraše; (f) `## Agentai` pirmas ne `readme-guard`.
3. **Vienas kelių skaičius, viena riba.** Kanoninis `allowedPaths` ima TIK bullet'us (150
   paliko ne-bullet kelią); `size.ts`, policy advisory ir `enforceExecutionBudget` skaito TĄ
   PATĮ skaičių; `maxAllowedPaths` 8 / `max_files_per_task` 10 / `max_files` 8 suvedami į vieną
   konfigo reikšmę.
4. **Testai:** korpuso testas (queue + done) bėga vienam validatoriui; etalono taisyklių
   inventoriaus sync testas — kiekvienas `> N.` punktas `## Failai` komentare turi atitikmenį
   rule id sąraše arba eksplicitinę „LLM sprendžia" žymę.
5. **Kelių egzistavimas** — preflight (CLI) FS patikra: deklaruotas kelias neegzistuoja ir jo
   bullet'e nėra „numatomas"/„naujas" — pažeidimas. Vienintelė taisyklė su FS, todėl ne domain'e.

Šaltiniai: `src/domain/tasks/etalonas-rules.ts`, `src/application/quality-gates/preflight-fastpath.ts:128-320`,
`src/application/quality-gates/preflight-rules.ts:447`, `src/domain/tasks/size.ts:31-33,132`,
`src/domain/tasks/allowed-paths.ts:50-105`, `src/application/token-governance/tool-budget-gates.ts:150`,
`src/interfaces/hooks/pre-hooks.ts:218-240`, `src/tests/{task-etalonas-sync,domain-tasks-etalonas-rules,quality-gates-preflight}.test.ts`,
`vq/config/{preflight-limits,context-budget}.json`, `vq/logs/orchestrator.log` (09:51 all-blocked; 12:27 101-b-03).
