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
`planIncrementalStep` sargas `worker-integration.ts:180` (`live.length === 0`) yra nepasiekiamas: kvietėjas visada paduoda bent vieną gyvą slot'ą (patį baigusįjį). Klaidinanti „gyva" blokavimo šaka pakeičiama assert'u arba komentaru, kuris įvardija nepasiekiamumą, kad kitas skaitytojas nebandytų jos dengti testu.

## Agentai
PRIVALOMA grandinė (ta pati eilės tvarka, be praleidimų): readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/worker-integration.ts`
- `src/tests/scheduling-wave-integration-coordinator.test.ts`

Draudžiama:
- `src/application/scheduling/wave-provisioning.ts`
- `src/application/scheduling/wave-scheduler.ts`
- `src/infrastructure/git/worktrees/worktree-owner.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: patvirtinti Grep'u, kad joks `planIncrementalStep` kvietėjas negali paduoti tuščio `live` masyvo, ir pasirinkti formą — invariantą įvardijantis komentaras ar `assert`.
- Coder: pakeisti šaką pagal architect'o sprendimą; kitos keturios blokavimo priežastys ir jų tekstai NEkeičiami.
- Tester: patikrinti, kad esami integracijos koordinatoriaus testai lieka žali ir kad nė vienas nesirėmė šia priežastimi.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei atsiranda kvietėjas, galintis paduoti tuščią `live` — tada tai gyva šaka ir jos liesti negalima.

## Neįtraukta
Kitos `planIncrementalStep` blokavimo priežastys. Write set sankirtos logika. Kiti 077 audito punktai — atskiri vaikai.
