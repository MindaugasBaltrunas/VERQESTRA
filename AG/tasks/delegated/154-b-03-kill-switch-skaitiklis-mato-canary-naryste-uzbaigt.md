## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- `154-kohortu-arm-as-skaitomas-tik-is-pack-o-irasu-finalize-nedemotuoja` (duoda `describesContextPack` predikatą `src/application/context-pack/metrics.ts`)

## Tikslas
`worker-prompt-preparation.ts` vėliausio `canary_features` žemėlapis irgi mato sintetines finalize eilutes be lauko, todėl užbaigtiems dispatch'ams canary narystė dingsta ir K trigger'is (human-review arrest) jiems nebeveikia. Žemėlapis turi remtis tik pack'o įrašais.

## Agentai
PRIVALOMA grandinė šia tvarka: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts`
- `src/tests/interfaces-cli-dispatch-runtime.test.ts`

Draudžiama:
- `src/application/context-pack/metrics.ts`
- `src/application/analytics/attempt-identity-join.ts`
- `src/infrastructure/adapters/claude-dispatch-finalize.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `worker-prompt-preparation.ts` ~59-69 eil.: pritaikyk `describesContextPack` prieš `latest.set` — įrašai, kurie pack'o neaprašo, žemėlapio nekeičia.
- `interfaces-cli-dispatch-runtime.test.ts`: atvejis su fake `readContextSizeMetrics` — pack'o eilutė su `canary_features` plius vėlesnė finalize eilutė be jų → task'as lieka canary.
- Interfaces sluoksnis importuoja tik iš application/domain/shared; jokio infrastructure importo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei predikato pritaikymas pakeistų kill-switch elgesį dar nepradėtiems dispatch'ams.

## Neįtraukta
- Analytics kohortų skaitytojai — ankstesnė eilės užduotis.
- `dispatch_tool_schema` shadow poros rašymas (finalize `input.toolSchema.shadow` visada `undefined`) — atskiras task'as.
