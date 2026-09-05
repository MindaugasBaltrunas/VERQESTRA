# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 181-etalonas-rules-skaito-leidziama-bloka-kanoniniu-zymekliu

## Žingsnis 0 — ar jau įgyvendinta?
Tikrinti po punktą (dalis galėjo būti padaryta anksčiau): (1) `src/domain/tasks/dependencies.ts`
`resolveTaskReference` (135-141 eil.) NErezolvuoja nuorodos `0042-parent-02-child` į `0042-parent`,
kai vaiko visatoje nėra; (2) `dependencies.ts:75-78` doc sako, kad skenuojamas VISAS tekstas;
(3) `src/domain/tasks/size.ts:118` domenų sąraše yra `docs`; (4) `src/domain/tasks/graph/model.ts:124-130`
rūšiuoja be `localeCompare`; (5) `src/domain/scheduling/loop-runtime.ts:49-57` `JSON.parse("null")`
grąžina `undefined` be `TypeError`; (6) `src/domain/tasks/identity.ts` JSDoc apie goal atitinka
„pirma `## Tikslas` eilutė". Visi šeši — ALREADY_IMPLEMENTED su citatomis; kitaip daromi likę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Domain; pilna ataskaita
`audit-domain.md` #9, #10, #11, #12 (size dalis), #13 (graph/model dalis), #20).
- #10 `dependencies.ts:135-141` `resolveTaskReference` simetriškas: nuoroda į vaiką, kurio visatoje
  NĖRA, rezolvuojasi į tėvą → priklausomybė patenkinama tėvo `done`, nors vaikas niekada nevyko
  (fail-open). Kryptis: vaikas → tėvas tik kai vaikas visatoje YRA ir yra to tėvo skėlimo dalis;
  nežinomas id lieka nežinomas (etalonas: `priklausomybe-unknown-id`).
- #9 `dependencies.ts:75-78` doc „Reads a task's `## Dependencies` section", kodas skenuoja visą
  tekstą (`domain-tasks.test.ts:91` pina kaip tyčinį) — suderinti doc'ą; `## Veiksmas` sakinys
  „pridėk `depends_on: foo`" tampa tikra priklausomybe — įvardyti doc'e kaip žinomą kainą.
- #11 `identity.ts:28,118-123` goal = TIK pirma `## Tikslas` eilutė (pinta `domain-tasks.test.ts:58-61`),
  JSDoc „Normalized goal text (collapsed whitespace)" to nesako; tuščias `## Tikslas` prieš
  `## Agentai` duoda goal `"## Agentai"` — antraštė negali būti goal'u.
- #12 `size.ts:118` meta sąraše `doc`, repo katalogas `docs/` → `docs/audits/x.md` + `src/...` = 2
  domenai (gali kirsti `maxDomains`).
- #13 `graph/model.ts:124-130` hash payload'o tvarka per `localeCompare` (ICU priklausoma) →
  „same graph → same hash" galioja tik toje pačioje aplinkoje; kitoje mašinoje snapshot'as gali
  gauti `graph-hash-mismatch`. Kryptis: kodo taškų palyginimas (`<`/`>` ant string'ų), kaip
  `shared/json.ts` kanoninis rūšiavimas.
- #20 `loop-runtime.ts:49-57` `JSON.parse("null")` → `parsed.pid` meta `TypeError` už `try` ribų;
  doc žada „bet kokia neatitiktis — `undefined`".

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/dependencies.ts` (75-78 doc; 135-141 `resolveTaskReference`)
- `src/domain/tasks/identity.ts` (28, 118-123 eil. JSDoc ir antraštės filtras)
- `src/domain/tasks/size.ts` (118 eil. `doc` → `docs`)
- `src/domain/tasks/graph/model.ts` (124-130 eil. rūšiavimas)
- `src/domain/scheduling/loop-runtime.ts` (49-57 eil. `null` sargas)
- `src/tests/domain-tasks.test.ts`
- `src/tests/domain-task-graph.test.ts`
- `src/tests/interfaces-hooks-loop-runtime.test.ts`

Draudžiama:
- `src/domain/tasks/allowed-paths.ts` ir `src/domain/tasks/etalonas-rules.ts` (task 178/181)
- `src/domain/architecture/graph-hash.ts` (#13 antra pusė — task 194)
- `src/domain/policies/commit-message.ts` (#12 antra pusė — task 188)
- `src/application/scheduling/**` (kitas autorius)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `dependencies.ts`: `resolveTaskReference` — vaikas→tėvas tik kai `knownIds` turi vaiką (arba tėvo
  skėlimo prefiksą su tuo pačiu numeriu ir vaiko sufiksu); testai `domain-tasks.test.ts` ir
  `scheduling-task-identity.test.ts` (importuoja `resolveTaskReference`; NE šio scope — jei jis
  raudonuoja, semantika turi likti tokia, kokią jis pina, o pataisa siaurinama iki nežinomo vaiko).
- `identity.ts`: goal skaitytojas praleidžia eilutes, prasidedančias `#`; JSDoc: „pirma neantraštinė
  `## Tikslas` eilutė, tarpai suspausti".
- `size.ts`: `docs` (palikti ir `doc` suderinamumui, jei etalono testai to reikalauja); testas —
  `docs/audits/x.md` + `src/a.ts` = 2 domenai su `docs` vardu, ne `doc`.
- `graph/model.ts`: rūšiavimas be `localeCompare`; testas — hash nepriklauso nuo įėjimo tvarkos ir
  sutampa su fiksuotu literalu.
- `loop-runtime.ts`: `parsed === null || typeof parsed !== "object"` → `undefined`; testas su `"null"`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `graph/model.ts` rūšiavimo pakeitimas keičia
esamų snapshot'ų hash'us ir `scheduling-*` testai (svetimas scope) pina literalus — tada hash'o
versijos kėlimas yra scheduling autoriaus sprendimas.

## Neįtraukta
- `graph-hash.ts` (architektūros grafas, #13 antra pusė) — task 194.
- `commit-message.ts` `doc` → `docs` — task 188.
- `log-digest.ts:135` `includes(taskId)` — task 193.
