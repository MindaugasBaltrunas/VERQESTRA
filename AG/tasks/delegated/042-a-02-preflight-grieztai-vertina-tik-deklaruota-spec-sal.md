## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
`ensureSpecSource` „Invalid OpenSpec reference" verdiktą turi kelti tik dėl `## Spec source` sekcijoje DEKLARUOTŲ nuorodų; kūno citata ar paminėjimas verdikto nebekeičia.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester
Privaloma naudoti būtent šią grandinę ir tokia tvarka.

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts`
- `src/tests/interfaces-cli-preflight.test.ts`

Draudžiama:
- `src/application/task-planning/openspec-context.ts`
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- `ensureSpecSource` blogųjų nuorodų sąrašą (`spec-source.ts:92-99`) skaičiuok iš `analyzeDeclaredOpenSpecReferences`, kviečiamos su `ports.openSpec` ir `ports.projectRoot`; `input.openSpecRefs` toliau lieka `activeChangeDirs` auto-OpenSpec vartui (`spec-source.ts:101`) ir kontekstui — tvarkingo task'o elgesys nesikeičia.
- Po auto-sugeneruotos nuorodos įrašymo (`appendSpecSourceRef`) perskaičiuok ir deklaruotų nuorodų analizę, kad naujas šaltinis būtų vertinamas tais pačiais vartais.
- Testai `src/tests/interfaces-cli-preflight.test.ts`: (1) kūno citata su nesama/archyvine nuoroda + tvarkingas `## Spec source` -> verdiktas nebe human_review; (2) tokia pat bloga nuoroda pačioje `## Spec source` sekcijoje -> tebekrenta su ta pačia priežastimi; (3) auto-OpenSpec generavimo kelias veikia kaip veikęs.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei prireiktų keisti `claude-preflight/index.ts` (041 laukas) arba silpninti deklaruotų nuorodų validaciją.

## Neįtraukta
- `openspec-context.ts` keitimai — ankstesnis task'as.
- Nukrypimo nuo etalono įrašas — kitas task'as.
- 041 `decision.json` `task_id` antspaudavimas.
