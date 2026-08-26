# Task

## Spec source
- `openspec/changes/verqestra-backlog-v1`
- Originalus turinys (spec.md, design.md) gyvas archyve, slug'as
  `auto-037-task-numeris-vienareiksmis-per-visa-gyvavimo-c`. Pilnas kelias čia NERAŠOMAS
  sąmoningai: archyvinė nuoroda bet kurioje task'o eilutėje yra automatinis preflight atmetimas
  (`openspec-context.ts:61,84`). Kodėl nuoroda pasikeitė — `docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md`, skyrius R4.
- `src/application/task-planning/generate.ts`

## Tikslas
Du lygiagretūs `taskGenerate` kvietimai neturi gauti to paties šaknies numerio: po numerio parinkimo ir PRIEŠ rašymą numeris pertikrinamas, o radus konfliktą — didinamas ir kartojama ribotą kartų skaičių.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-planning/generate.ts`
- `src/application/task-execution/enqueue-child-tasks.ts`
- `src/tests/application-task-planning-generate.test.ts`

Draudžiama:
- `src/infrastructure/**`
- `AG/tasks/**`
- `vq/**`
- `.env`

## Veiksmas
- `taskGenerate`: prieš rašymą pertikrinti, ar joks bucket'o failas nepradeda parinktu numeriu; radus — numeris +1 ir kartoti; viršijus ribotą bandymų skaičių — aiški klaida su numeriu ir bandymų kiekiu.
- Testas: simuliuoti lygiagretų to paties numerio failo atsiradimą tarp parinkimo ir rašymo — patikrinti, kad numeris paslenka, ir kad viršijus limitą metama klaida.
- `enqueue-child-tasks.ts` galvutės komentare pridėti vieną pastraipą: šeimos bazės vienareikšmiškumą nuo šiol garantuoja `src/tests/task-number-uniqueness.test.ts` vartas.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok ir klausk, jei: pertikrinimui prireiktų naujo porto ar naujo fs skaitymo už esamų `task-planning` portų ribų; arba jei retry logika keistų jau egzistuojančių task failų vardus.

## Neįtraukta
- Atskiras CLI rankinei kūrybai — vartas #1 yra saugiklis.
- Esamų failų pervadinimas ar istorijos taisymas.
