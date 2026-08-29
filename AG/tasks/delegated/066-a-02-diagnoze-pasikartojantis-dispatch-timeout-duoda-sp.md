## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 073-registraciju-valymas-visuose-worktree-salinimo-keliuose
- 074-neintegruoto-w2-darbo-apsauga-po-proceso-luzio
- 078-worktree-bootstrap-buildstamp-ir-pnpm-path-spragos
- 079-orphan-valymas-iveikia-untracked-failus-ir-fs-liekanas
- 080-vaiko-exit-visada-palieka-diagnoze-ir-stderr

## Tikslas
Dabar pasikartojantis dispatch timeout (exit 124) su ta pačia retry-signature veda į human_review arba dar vieną retry — GeoGravity 1178 taip sudegino tris ciklus po ~100 min. Domain sluoksnyje reikia deterministinio sprendimo: kai timeout parašas kartojasi (>=2 bandymai), verdiktas yra `split`; `human-review` lieka fallback'u tik kai taskas nedalomas (1 veiksmas, 1 kelias).

Papildymas (operatorius, 2026-08-29, GeoGravity auditas): tas pats `split` verdiktas taikomas ir RAW TOKEN lubų perviršiui — GeoGravity 7 dispatch'ai viršijo 10M raw lubas (iki 25.5M) su „diagnostika, baigtis nekeičiama", ir 1178 @ 2.5× baigėsi exit 124. Raw perviršis (>1.2× lubų) diagnozės įvestyje traktuojamas kaip tas pats runtime-oversize signalas kaip timeout parašas. Lubų reikšmė nekeičiama.

## Agentai
PRIVALOMA grandinė be praleidimų: readme-guard -> architect -> schedule-domain -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/diagnosis/dispositions.ts`
- `src/tests/characterization-diagnosis.test.ts`

Draudžiama:
- `src/application/**`
- `src/interfaces/**`
- `dist/**`
- `ui-app/**`

## Veiksmas
- Įvesti gryną funkciją, kuri iš įėjimų (exit kodas, pasikartojančių to paties parašo bandymų skaičius, dalumo požymis) grąžina `split` | `human-review` | `repair`; jokio `node:` importo, jokio IO.
- Praplėsti verdiktų tipą 'split' reikšme taip, kad esami `LocalDiagnosisVerdict` / `NoCommitDisposition` skaitytojai liktų tipiškai teisingi.
- Testai: timeout×1 -> `repair`; timeout×2 su tuo pačiu parašu -> `split`; timeout×2 nedalomam task'ui -> `human-review`; esami charakterizavimo testai nepakitę.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei sprendimui prireiktų `node:` importo, IO porto arba application sluoksnio tipo — tai reikštų, kad logika ne domain'e.

## Neįtraukta
Maršruto pajungimas run-coordinator'yje, tėvo superseded žymėjimas ir žurnalo eilutė — kitas darbas. renderTaskPart commit_log pataisymas (jau atliktas).
