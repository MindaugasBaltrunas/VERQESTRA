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
`openspec/changes/verqestra-backlog-v1/`

## Tikslas
Waves view atsakymas turi pasakyti, ar worktree politika įjungta, kad `#/system` lease'ų lentelės tuštumą UI galėtų paaiškinti PRIEŽASTIMI, o ne „lease'ų nėra". Šiandien view politikos nemato iš viso, tad pridedamas vienas opcionalus wire laukas ir jį maitinantis portas.

## Agentai
Privaloma grandinė (nepraleisk nė vieno): `readme-guard -> architect -> coder -> reviewer -> tester`.

## Failai
Leidžiama:
- `src/interfaces/http/ui-waves-view.ts`
- `src/composition/ui/router-adapters.ts`
- `src/tests/interfaces-http-waves-view.test.ts`

Draudžiama:
- `src/application/**`
- `src/domain/**`
- `src/infrastructure/**`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Į `WavesViewPorts` pridėk portą `readWorktreePolicyEnabled(absoluteConfigFile: string): Promise<boolean>`; absoliutų kelią (`<runtimeRoot>/config/worktree-policy.json`) skaičiuoja pats view, kaip jau daro `readTailLines`.
- `buildWavesView` skaito jį per esamą `readSource` (šaltinio vardas `worktree_policy`, nesėkmė → `degraded`) ir grąžina opcionalų lauką per sąlyginį spread'ą (`exactOptionalPropertyTypes`): `worktree_policy?: { enabled: boolean; config_path: string }`, kur `config_path` yra PROJEKTUI RELATYVUS POSIX kelias (`vq/config/worktree-policy.json`), niekada absoliutus.
- `src/composition/ui/router-adapters.ts` `wavesView` bloke suriša portą su `loadWorktreePolicy` iš `application/scheduling/worktree-policy.js` ir esamu `nodeFsAdapter.readTextFileIfExists`; `application` failų NEKEISK.

## Patikra
- `pnpm typecheck`
- `pnpm test:file dist/tests/interfaces-http-waves-view.test.js`
- `pnpm test`

## Stop
Testeris privalo dengti tris atvejus: politika įjungta, politika išjungta (arba failo nėra → `enabled: false`) ir neperskaitomas politikos failas (laukas praleistas, `degraded` turi `worktree_policy`). Commit'ink, kai abi patikros žalios. Stop ir klausk, jei koks nors vartas pareikalautų keisti `ui-app` tipus ar `application` sluoksnį.

## Neįtraukta
UI pusė (`WavesPanel`/`RuntimePanel` tuščių būsenų tekstai ir `ui-app` tipai) — atskira užduotis.
