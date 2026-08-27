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
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „Dispatch paruošimo shadow matavimas")
- Laukai JAU egzistuoja: `src/application/context-pack/metrics.ts` eilutės 102-145 (`toolSchemaFullChars`/`toolSchemaReducedChars`) — tik naudoti, NEKEISTI.

## Tikslas
`resolveDispatchToolSchemaProfile` grąžinamą profilį papildyti shadow pora (pilnos vs sumažintos įrankių schemos char dydžiai), skaičiuojama VISIEMS režimams, įskaitant `mode: "off"`. Realiai perduodami `candidates`/`applied` sąrašai nesikeičia nė vienu simboliu.

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/adapters/claude-dispatch-delivery.ts`
- `src/tests/interfaces-cli-dispatch-plan.test.ts`

Draudžiama:
- `src/application/context-pack/metrics.ts`
- `src/infrastructure/adapters/claude-tool-schema.ts`
- `src/infrastructure/adapters/claude-dispatch-finalize.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/command.ts`
- `AG/**`
- `vq/**`
- `ui-app/**`

## Veiksmas
- `DispatchToolSchemaProfile` papildyti NEPRIVALOMU lauku `shadow?: { fullChars: number; reducedChars: number }`; grąžinti per sąlyginį spread'ą (`exactOptionalPropertyTypes`).
- Inventorius = `DISPATCH_BASELINE_TOOLS` (importas iš `claude-tool-schema.ts`, redaguoti jo negalima) ∪ `input.mcp.tools`. `fullChars` = viso inventoriaus `JSON.stringify` ilgis; `reducedChars` = to paties inventoriaus be `applied` įrankių ilgis. Kai `input.mcp.known === false`, `shadow` lieka `undefined` (pjūvis neautoritetingas) — niekada `0`. Komentare įvardink, kad tai VARDAIS grįstas proxy: registre schemų kūnų nėra.
- Testai `src/tests/interfaces-cli-dispatch-plan.test.ts`: (a) `enabled: false` → `mode: "off"` IR `shadow` pora užpildyta, `applied` nepakitęs; (b) `mcp.known === false` → `shadow === undefined`; (c) `mode: "applied"` → `reducedChars < fullChars`.

## Patikra
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`

## Stop
Pirma patikrink, ar jau įgyvendinta: jei `shadow` pora jau grąžinama, NEDARYK pakeitimų ir ataskaitą pradėk atskira eilute `ALREADY_IMPLEMENTED: <failai/eilutės>`. Commit'ink tik kai visos patikros žalios. Sustok ir raportuok, jei matavimui reikėtų pakeisti `candidates`/`applied` turinį arba redaguoti failą už `## Failai` ribų.

## Neįtraukta
- Poros rašymas į `context-size.jsonl` (`claude-dispatch-finalize.ts`) — kita nuosekli užduotis.
- `bash_output_digest`, `symbol_slices`, `compact_dsl` rašytojai; `decideCompression` verdiktas; `ui-app` vertimai; `dispatch_tool_schema` vėliavos įjungimas.
