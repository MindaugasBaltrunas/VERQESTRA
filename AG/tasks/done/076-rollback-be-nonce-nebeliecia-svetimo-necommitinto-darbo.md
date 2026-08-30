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

## Tikslas
Audito P1 (2026-08-29): kai `AG_DISPATCH_NONCE` tuščias, `filterStagePathsByOwnership` (`src/application/task-execution/session-write-owners.ts:97-99`) grąžina VISĄ ledger'į, tad `taskScopeRestorePaths` į rollback atstatymo aibę įtraukia ir svetimų sesijų kelius — svetimas necommit'intas darbas revertinamas. Šioje dalyje pataisoma TIK application sluoksnio taisyklė: rollback kelyje be nonce svetimų sesijų keliai atskiriami kaip `foreign` (savininkystė imama iš savininkų sidecar'o, ne iš kvietėjo tapatybės), o nenustatomos savininkystės kelias (senas įrašas be sidecar'o) yra fail-closed — NEatstatomas ir raportuojamas.

## Agentai
Privaloma grandinė (be praleidimų): readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/session-write-owners.ts`
- `src/tests/interfaces-hooks-session-summary.test.ts`
- `src/tests/task-execution-session-write-owners.test.ts`

Draudžiama:
- `src/infrastructure/git/rollback-scope.ts`
- `src/interfaces/cli/bootstrap/rollback-stable.ts`
- `src/application/task-execution/session-stage-planning.ts`
- `src/interfaces/hooks/package-guard.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: `filterStagePathsByOwnership` be-nonce elgesio (nieko nemeta) NEKEISTI — tai Stop staging'o kontraktas su 3 kitais kvietėjais; griežtesnę rollback taisyklę įgyvendinti atskirai (nauja gryna funkcija arba `taskScopeRestorePaths` vidinė logika), grąžinant ir `foreign`/`skipped` kelius kaip naują eksportą, o esamą `taskScopeRestorePaths(...): string[]` parašą palikti suderinamą su `rollback-scope.ts:220`.
- Coder: be nonce kelias atstatomas tik kai savininkų įrašas įrodo, kad jis šio task'o (`tasks` sutampa su `current-task-id`); svetimas → `foreign`; be įrašo ar tuščios sesijos → fail-closed praleidimas su priežastimi.
- Tester: perrašyti `src/tests/interfaces-hooks-session-summary.test.ts:147` atvejį (jis įtvirtina seną be-nonce elgesį) ir pridėti tris atvejus: savas kelias → atstatomas; svetimos sesijos kelias be nonce → NEatstatomas ir yra `foreign` sąraše; kelias be savininkystės → praleistas su priežastimi.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Testų nesilpninti. Sustok ir klausk, jei paaiškėja, kad `foreign` sąrašo neįmanoma perduoti nekeičiant `rollback-scope.ts` porto kontrakto.

## Neįtraukta
`rollback-stable` CLI ataskaita apie praleistus svetimus kelius (kitas task'as). `rollback-scope.ts` mechanika. Preserved ref'ų retencija (075). UI.
