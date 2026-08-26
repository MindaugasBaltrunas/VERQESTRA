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
openspec/changes/verqestra-backlog-v1
docs/audits/ (slot-2 auditas 2026-08-26, radinys 3, antra pusė) — pirma dalis iš dviejų

## Tikslas
Du glob'ai su tuo pačiu kietu prefiksu, kurių likusios dalys negali sutapti nė viename kelyje, nebeturi būti skelbiami sankirta. Ko įrodyti nepavyksta — lieka sankirta (fail-closed nesilpninamas).

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/domain/scheduling/scope-lock-rules.ts`
- `src/tests/scope-lock-rules.test.ts`

Draudžiama:
- `src/application/scheduling/conflict-detector.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- `scopesConflict` glob/glob šakoje (`scope-lock-rules.ts:175-183`) šiuo metu lyginami tik kieti prefiksai (`solidPrefix`), todėl `src/tests/a-*.test.ts` vs `src/tests/b-*.test.ts` gauna sankirtą, nors nė vienas failas negali atitikti abiejų šablonų.
- Pridėk ĮRODOMO nepersidengimo atvejį: kai abiejų šablonų likusios dalys po bendro kieto prefikso negali sutapti nė viename kelyje, grąžink `false`. Visais kitais atvejais elgesys nesikeičia — tuščias prefiksas ir `**` lieka „gali persidengti".
- Testai `src/tests/scope-lock-rules.test.ts`: nepersidengiantys glob'ai → ne sankirta; persidengiantys glob'ai → sankirta; `**/index.ts` vs `src/**` → sankirta (esamas fail-closed atvejis nesugadintas).

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok nedelsiant, jei sprendimas reikalautų grąžinti `false` porai, kurios nepriklausomumo įrodyti nepavyksta: klaidingas `independent` reiškia du vykdytojus tame pačiame faile ir kainuoja brangiau nei prarastas lygiagretumas. Sustok ir jei prireiktų liesti `conflict-detector.ts`.

## Neįtraukta
- `wildcard-scope` spragos ribotos/neribotos apimties atskyrimas (`src/application/scheduling/conflict-detector.ts`) — atskira, iš karto sekanti užduotis.
- Užduočių `## Failai` konvencija (task 034).
- `worktree-policy.json` įjungimas ir worker prašymo numatytosios reikšmės.
