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
Uždaryti jau egzistuojantį OPCIONALŲ waves view portą `readWorktreeGitignoreOk` (`src/interfaces/http/ui-waves-view.ts:174`) tikru fs adapteriu composition sluoksnyje, kad `worktree_gitignore_ok` waves view atsakyme būtų realiai matuojamas, o ne praleistas.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/ui/router-adapters.ts`
- `src/tests/composition-worktree-policy-wiring.test.ts`

Draudžiama:
- `src/interfaces/http/ui-waves-view.ts`
- `src/interfaces/http/ui-worktree-policy.ts`
- `src/interfaces/http/ui-router-mutations.ts`
- `src/application/scheduling/**`
- `.gitignore`
- `dist/**`

## Veiksmas
- Coder: greta esamo `readWorktreePolicyEnabled` (apie `router-adapters.ts:167`) pridėti `readWorktreeGitignoreOk` adapterį — skaito `.gitignore` iš projectRoot skaičiuoto kelio ir grąžina, ar worktree kelias jame padengtas; kelias niekada neimamas iš request'o.
- Coder: nesantis arba neperskaitomas `.gitignore` neturi griauti waves view — laikytis esamos degraded semantikos (`readSource`), kurią jau tikrina `src/tests/interfaces-http-waves-view.test.ts`.
- Tester: naujame teste padengti adapterio elgesį — padengtas `.gitignore`, nepadengtas, ir nesantis failas.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei adapteriui prireiktų keisti `ui-waves-view.ts` porto kontraktą arba rašyti į `.gitignore`.

## Neįtraukta
POST `/api/runtime/worktree-policy` maršrutas (kitas darbas). Mutacijos portų surišimas (trečias darbas). Politikos VARTOJIMAS scheduling sluoksnyje nekeičiamas.
