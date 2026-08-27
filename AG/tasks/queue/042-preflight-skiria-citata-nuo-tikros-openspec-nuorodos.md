# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md (skyrius „R5")

## Tikslas
Preflight'o OpenSpec vartai turi vertinti tik DEKLARUOTĄ spec šaltinį, o ne kiekvieną
`…changes/…` paminėjimą task'o kūne. Dabar citata, klaidos tekstas ar archyvinio kelio
paminėjimas prozoje paskelbiamas „Invalid OpenSpec reference" ir task'as krenta į
human-review, nors tikroji `## Spec source` nuoroda yra tvarkinga.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-planning/openspec-context.ts`
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts`
- `src/tests/task-planning.test.ts`
- `src/tests/interfaces-cli-preflight.test.ts`

Draudžiama:
- `src/application/task-planning/openspec-slug.ts`
- `src/interfaces/cli/dispatch/claude-preflight/index.ts` (tai 041 task'o laukas)
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI (klaidos klasė, trys kritimai per parą): `039` krito 2026-08-26 19:28:51 dėl
  archyvinio kelio PAMINĖJIMO; `041` krito 21:42:55 dėl nukirsto kelio CITATOS kūne, o
  2026-08-27 05:25:52 — antrą kartą dėl pastabos, kuri citavo pirmojo kritimo klaidos tekstą.
  Įspėjimas apie spąstus pats buvo spąstai.
- Mechanizmas: `extractOpenSpecChangeRefs` (`src/application/task-planning/openspec-context.ts:61`)
  regex'u renka nuorodas iš VISO task teksto; `analyzeOpenSpecReferences` kiekvieną nesamą /
  archyvinę / template priskiria blogosioms, o `claude-preflight/spec-source.ts:92-99` iš to
  daro `human_review` verdiktą. Regex'as neskiria backtick citatos nuo deklaracijos.
- SPRENDIMO KRYPTIS: griežtoji validacija (missing/archived/template -> human_review) taikoma
  TIK `## Spec source` sekcijoje deklaruotoms nuorodoms. Kūno paminėjimai lieka tam, kam jie
  naudingi — konteksto praturtinimui (`buildOpenSpecContext` aktyvios nuorodos): nesamas kūno
  paminėjimas tyliai ignoruojamas, be verdikto.
- Architektui spręsti: ar `activeChangeDirs` semantika (`spec-source.ts:101` auto-OpenSpec
  vartas) toliau mato kūno aktyvias nuorodas, ar tik deklaruotas — bet kuriuo atveju esamas
  auto-generavimo elgesys tvarkingam task'ui NEGALI pasikeisti.
- ATMESTA alternatyva: ignoruoti nuorodas backtick'uose. Trapu — prozos paminėjimas be
  backtick'ų klumpa toliau, o tai, kad 039/041 citatos buvo backtick'uose, yra atsitiktinumas.
- Tai nukrypimas nuo etalono elgesio (etalonas turi tą pačią spragą): įrašyti į
  `migration-coverage.json` ir commit ataskaitą su priežastimi. Kryptis ne silpninanti —
  deklaruotos nuorodos tikrinamos kaip tikrintos, dingsta tik klaidingi teigiami.
- Testai: (1) kūno citata su nesamu ar archyviniu keliu, kai `## Spec source` tvarkingas ->
  verdiktas NEkeičiamas (nebe human_review); (2) nesama / archyvinė / template nuoroda pačiame
  `## Spec source` -> tebekrenta human_review su ta pačia priežastimi; (3) konteksto
  praturtinimas iš aktyvios nuorodos veikia kaip veikęs.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei sprendimas imtų reikalauti keisti
`claude-preflight/index.ts` (041 laukas — palauk jo) arba silpninti `## Spec source`
deklaruotų nuorodų validaciją.

## Neįtraukta
- 041 turinys (`decision.json` `task_id` antspaudavimas) — atskiras task'as, bendras tik
  testų failas `interfaces-cli-preflight.test.ts`, todėl planuoklė juos serializuos.
- `slugFromTask` 50 simbolių riba ir auto-change katalogų kelių forma.
- Retrospektyvus 039/041 tekstų valymas — jie jau apeiti rankiniu redagavimu.
