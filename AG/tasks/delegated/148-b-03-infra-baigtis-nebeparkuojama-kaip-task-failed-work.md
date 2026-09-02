## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 148-a-02-runchild-grazina-infra-baigti-vietoj-boolean-comma

> 2026-09-02 pataisyta: priklausomybė buvo įrašyta proza („148 vaikas 2 …"), ne task id, tad
> planuoklė jos nematė ir paleido šį task'ą lygiagrečiai su 148-a-02. Vykdytojas teisingai
> sustojo be pakeitimų (`runChild` infra baigties šakoje dar nebuvo), o užbaigimo sargas parkavo
> „executor made no write-tool calls". Be 148-a-02 sulieto darbo čia nėra ką atskirti nuo
> `!slot.succeeded`.

## Tikslas
`src/application/scheduling/worker-integration.ts:245-253` ir `292-299` kiekvieną `!slot.succeeded` slot'ą su `worktree_path` parkuoja `task-failed` į human-review. Dėl to 2026-09-01 21:17–21:31 dvidešimt task'ų (1232–1254) po ~5 s (`events=0`) atsidūrė human-review vien dėl Claude usage limito. Infra baigtis NIEKADA nėra `task-failed` parkas.

## Agentai
PRIVALOMA grandinė (nekeisti, neapeiti): readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/scheduling/worker-integration.ts`
- `src/application/scheduling/wave-outcome.ts`
- `src/tests/scheduling-pool.test.ts`

Draudžiama:
- `src/application/scheduling/loop-cycle.ts`
- `src/application/scheduling/wave-provisioning.ts`
- `src/application/task-execution/run-coordinator-terminal.ts`
- `src/infrastructure/adapters/claude-dispatch-outcome.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `worker-integration.ts`: infra baigties slot'as nei `integrate`, nei `park` — task failas lieka queue, kopija ir šaka paliekamos kaip `task-failed` kelyje, slot'o lease atlaisvinamas, žurnalo eilutė aiškiai įvardija infra priežastį ir exit kodą.
- `wave-outcome.ts`: `recordOutcome` gauna atskirą infra atšaką vietoj `task_failed`, jei architect taip nusprendžia; kitu atveju palik nepakeistą ir pagrįsk.
- `scheduling-pool.test.ts`: testas, kad infra baigties slot'as neparkuojamas į human-review ir nefiksuojamas kaip `task_failed`.

## Patikra
- `pnpm test`

## Stop
Sustok ir klausk, jei: infra baigties atveju atrodo būtina liesti task failą pagrindiniame medyje; reikėtų keisti `wave-provisioning` mechaniką; esamas testas reikalauja seno parkavimo elgesio (testas nesilpninamas).
Kai `pnpm test` žalias, commit'ink tik šio task'o failus ir baik.

## Neįtraukta
`loop-cycle` refill hold / loop abort po infra slot baigties — atskiras task'as.
