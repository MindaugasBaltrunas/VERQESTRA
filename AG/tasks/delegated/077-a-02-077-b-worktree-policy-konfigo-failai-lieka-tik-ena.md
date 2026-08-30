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
Suderinti worktree konfigo failus su jau išvalytu `WorktreePolicy` kontraktu (`src/application/scheduling/worktree-policy.ts` — tipas turi TIK `enabled`). Šiuo metu abu JSON failai dar deklaruoja `root`, `branchPrefix`, `pathPrefix` — laukus, kurių niekas neskaito. Jie meluoja operatoriui apie tai, ką jis valdo.

## Agentai
PRIVALOMA grandinė, ta pati eilės tvarka, be praleidimų:
`readme-guard -> architect -> coder -> reviewer -> tester`

## Failai
Leidžiama:
- `templates/vq/config/worktree-policy.json`
- `vq/config/worktree-policy.json`

Draudžiama:
- `src/application/scheduling/worktree-policy.ts`
- `src/composition/loop/wave-scheduler-adapters.ts`
- `src/composition/ui/router-adapters.ts`
- `src/interfaces/http/ui-worktree-policy.ts`
- `src/tests/git-rules.test.ts`
- `src/tests/composition-worktree-policy-wiring.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: patvirtinti, kad abu failai pasiekiami tik per `loadWorktreePolicy` / `ui-worktree-policy` skaitymo kelią, ir įrašyti į ataskaitą verdiktą, ar template versijos kėlimas šiam pakeitimui taikomas (jei taikomas — STOP, nekelk pats).
- Coder: abiejuose failuose palikti vienintelį lauką `enabled` su NEPAKEISTA reikšme (`false`); LF eilutės, be BOM, failas baigiasi nauja eilute.
- Reviewer + tester: patvirtinti, kad joks produkcinis kelias ar testas nesiremia pašalintais laukais, ir paleisti patikras.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok ir klausk, jei: koks nors testas arba produkcinis kelias reikalauja `root`/`branchPrefix`/`pathPrefix`; template versijos kėlimas atrodo būtinas; arba reikėtų liesti bet kurį `src/**` failą.

## Neįtraukta
`enabled` reikšmės perjungimas (operatoriaus sprendimas, ne cleanup). Bet koks `src/**` pakeitimas. Template versijos kėlimas.
