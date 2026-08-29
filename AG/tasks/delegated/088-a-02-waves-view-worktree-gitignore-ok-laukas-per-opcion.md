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
Papildyti waves/system view atsakymą lauku `worktree_gitignore_ok: boolean` šalia esamo `worktree_policy` (059-a), kad UI matytų pilną w2 parengtį. Naujas portas deklaruojamas kaip OPCIONALUS (kaip ir esamas `worktree_policy` yra opcionalus laukas) — composition šiame darbe nekeičiama, todėl build lieka žalias; kai porto nėra, laukas praleidžiamas.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-waves-view.ts`
- `src/tests/interfaces-http-waves-view.test.ts`

Draudžiama:
- `src/composition/ui/router-adapters.ts`
- `src/interfaces/http/ui-router-mutations.ts`
- `src/application/scheduling/**`
- `vq/config/worktree-policy.json`
- `.gitignore`
- `dist/**`

## Veiksmas
- Coder: pridėti opcionalų portą `readWorktreeGitignoreOk(absoluteGitignoreFile): Promise<boolean>` ir lauką `worktree_gitignore_ok` į `worktree_policy` bloką per sąlyginį spread (`exactOptionalPropertyTypes`); klaida skaitant elgiasi kaip esamas `worktree_policy` degradavimo kelias.
- Tester: portas grąžina true → laukas true; false → false; porto nėra → laukas praleistas, o esamas `enabled`/`config_path` elgesys nepakitęs.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei portą tektų daryti privalomą (tai sugriautų composition be wiring).

## Neįtraukta
Composition wiring ir POST endpoint'as (kitas darbas). UI (kitas darbas).
