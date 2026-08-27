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
`application/task-planning` turi mokėti analizuoti OpenSpec nuorodas TIK iš task'o `## Spec source` sekcijos — atskirai nuo esamos viso teksto analizės, kuri lieka konteksto praturtinimui.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester
Privaloma naudoti būtent šią grandinę ir tokia tvarka.

## Failai
Leidžiama:
- `src/application/task-planning/openspec-context.ts`
- `src/tests/task-planning.test.ts`

Draudžiama:
- `src/application/task-planning/openspec-slug.ts`
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Pridėk eksportuojamą `analyzeDeclaredOpenSpecReferences(ports, projectRoot, taskText)`, kuri nuorodas renka tik iš `## Spec source` sekcijos ribų (fence-aware `shared/markdown.findSectionBounds`, kaip `claude-preflight/spec-source.ts:56`), o klasifikaciją (aktyvi / archyvinė / template / nesama) dalijasi su esama `analyzeOpenSpecReferences`.
- Nekeisk `analyzeOpenSpecReferences` ir `buildOpenSpecContext` elgesio: viso teksto nuorodos toliau maitina kontekstą.
- Testai `src/tests/task-planning.test.ts`: deklaruota aktyvi nuoroda randama; kūne cituota nesama nuoroda į deklaruotų rinkinį NEpatenka; be `## Spec source` sekcijos rezultatas tuščias.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei sprendimas imtų reikalauti keisti `claude-preflight/index.ts` arba silpninti esamą nuorodų klasifikaciją.

## Neįtraukta
- Preflight verdikto keitimas — kitas task'as.
- Nukrypimo nuo etalono įrašas — atskiras task'as.
- 041 turinys, `slugFromTask` riba, retrospektyvus 039/041 tekstų valymas.
