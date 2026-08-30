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
Pašalinti melagingus `WorktreePolicy` laukus `root`, `branchPrefix`, `pathPrefix` iš tipo, default'o ir parserio. Jie prieštarauja gyvoms konstantoms (`.ag/worktrees`, `ag/worker` — `worktree-layout.ts:11,14`) ir neturi nė vieno produkcinio skaitytojo (abu kvietėjai ima tik `.enabled`). Parseris privalo likti pereinamas: senas konfigas su pertekliniais laukais NElūžta — laukai ignoruojami.

## Agentai
PRIVALOMA grandinė (ta pati eilės tvarka, be praleidimų): `readme-guard -> architect -> coder -> reviewer -> tester`.

## Failai
Leidžiama:
- `src/application/scheduling/worktree-policy.ts`
- `src/tests/git-rules.test.ts`
- `src/tests/interfaces-http-worktree-policy.test.ts`
- `src/tests/composition-worktree-policy-wiring.test.ts`

Draudžiama:
- `templates/vq/config/worktree-policy.json`
- `vq/config/worktree-policy.json`
- `src/interfaces/http/ui-worktree-policy.ts`
- `src/composition/ui/router-adapters.ts`
- `src/tests/dead-export-gate.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: Grep'u patvirtinti, kad `root`/`branchPrefix`/`pathPrefix` neturi produkcinio skaitytojo (komentarai `ui-worktree-policy.ts:6` ir `router-adapters.ts:116` — ne skaitymas); įrodymą įrašyti į ataskaitą.
- Coder: palikti `WorktreePolicy = { enabled: boolean }`, išvalyti `defaultWorktreePolicy`, `parseWorktreePolicy` ir nebenaudojamus `stringField`/`safeRelativePath`/`safeName` helper'ius; pertekliniai JSON laukai ignoruojami, `enabled` validacija nekeičiama.
- Tester: testas, kad konfigas TIK su `enabled` parsinamas ir kad senas failas su `root`/`branchPrefix`/`pathPrefix` NElūžta.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei kuris nors iš trijų laukų pasirodo turįs gyvą produkcinį skaitytoją, arba jei krenta testas failuose, kurių nėra `## Failai` sąraše.

## Neįtraukta
Konfigo JSON failų valymas (`templates/vq/config/worktree-policy.json`, `vq/config/worktree-policy.json`) — kitas vaikas. `primary-claim-unsupported` šaka, `planParallelWorktrees`, karantino skaitytojas ir `worker-integration.ts:180` sargas — atskiri vaikai.
