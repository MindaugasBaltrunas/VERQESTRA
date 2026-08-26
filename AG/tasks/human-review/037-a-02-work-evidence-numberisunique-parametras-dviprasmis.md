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
- `openspec/changes/verqestra-backlog-v1`
- Originalus turinys (spec.md p. 4–5, design.md) gyvas archyve, slug'as
  `auto-037-task-numeris-vienareiksmis-per-visa-gyvavimo-c`. Pilnas kelias čia NERAŠOMAS
  sąmoningai: archyvinė nuoroda bet kurioje task'o eilutėje yra automatinis preflight atmetimas
  (`openspec-context.ts:61,84`). Kodėl nuoroda pasikeitė — `docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md`, skyrius R4.
- `src/infrastructure/git/work-evidence.ts:48-62`

## Tikslas
Kai task'o numeris dviprasmis, įrodymų paieška privalo susiaurėti iki pilno id grep'o (kaip split vaikams). Unikaliam numeriui elgesys lieka byte-for-byte toks pat. Žinojimą apie unikalumą paduoda kvietėjas — infrastruktūra fs neskaito.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/work-evidence.ts`
- `src/tests/infrastructure-work-evidence.test.ts`

Draudžiama:
- `src/composition/**`
- `AG/tasks/**`
- `vq/**`
- `.env`

## Veiksmas
- `taskWorkEvidenceGrepArgs(taskId, numberIsUnique)`: kai `numberIsUnique === false`, ne-split-child task'ui grąžinti TIK pilno id grep'ą, be `\(NNN\)` ir `task NNN($|[^0-9-])` šablonų; kai `true` — masyvas identiškas dabartiniam.
- Pridėti neprivalomą `numberIsUnique?: boolean` lauką į `WorkEvidenceInput` (default `true`, per `exactOptionalPropertyTypes` sąlyginį skaitymą) ir perduoti jį iš `taskCommittedProductWorkSha` / `taskCommittedWorkSha`.
- Testai: regresija `taskWorkEvidenceGrepArgs(id, true)` === dabartinis masyvas keliems ne-split-child id; naujas atvejis `false` → tik pilnas id; split-child atvejis nesikeičia nė vienoje reikšmėje.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok ir klausk, jei: prireiktų `src/infrastructure/**` skaityti `AG/tasks` bucket'us (sluoksnių riba); prireiktų keisti `src/composition/loop/*-adapters.ts`; arba jei kuris nors esamas įrodymų testas taptų raudonas su `numberIsUnique = true` (tai reikštų, kad kryptis nebe griežtinanti).

## Neįtraukta
- Realus unikalumo skaičiavimas ir prijungimas composition sluoksnyje — atskira užduotis (default `true` palieka esamą elgesį nepakitusį).
- `taskGenerate` skyrimo lenktynės.
