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
Surišti `POST /api/runtime/worktree-policy` maršrutą su tikrais fs adapteriais: politikos failo skaitymas/rašymas, `.gitignore` skaitymas ir append, log eilutė. Visi keliai skaičiuojami iš runtimeRoot/projectRoot.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/ui/router-adapters.ts`
- `src/tests/composition-worktree-policy-wiring.test.ts`

Draudžiama:
- `src/interfaces/http/ui-worktree-policy.ts`
- `src/interfaces/http/ui-router-mutations.ts`
- `src/interfaces/http/ui-waves-view.ts`
- `src/application/scheduling/**`
- `vq/config/worktree-policy.json`
- `.gitignore`
- `dist/**`

## Veiksmas
- Coder: `router-adapters.ts` — sukurti `WorktreePolicyPorts` implementaciją (politikos read/write, `.gitignore` read/append, log eilutė) ir perduoti ją į router deps; keliai skaičiuojami iš runtimeRoot/projectRoot, niekada iš request'o.
- Coder: rašymas turi būti idempotentiškas — pakartotinis tas pats `enabled` nedubliuoja `.gitignore` eilutės.
- Tester: teste naudoti laikiną katalogą (jokio realaus repo `.gitignore` ar `vq/config` lietimo) ir padengti abu `enabled` kelius.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei surišimui prireiktų keisti interfaces porto kontraktą arba rašyti į repo šakninį `.gitignore` testo metu.

## Neįtraukta
UI jungiklis. Politikos VARTOJIMAS scheduling sluoksnyje nekeičiamas.
