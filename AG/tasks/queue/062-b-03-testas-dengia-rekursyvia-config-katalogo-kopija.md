# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Patvirtinti, kad bootstrap testas įrodo: config katalogas su `tool-budget.json` ir įdėtu pakatalogiu atsiranda worktree kopijoje, o `local.env` paritetas išlieka. Jei taip — ALREADY_IMPLEMENTED be rašymų.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/tests/worktree-runtime-bootstrap.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-runtime.ts`
- `src/composition/loop/command.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Patikrink, ar yra testas, kuris su `configDirs` sukuria config katalogą su `tool-budget.json` ir įdėtu pakatalogiu bei tvirtina, kad abu atsirado kopijoje.
- Patikrink, ar `local.env` per `configFiles` vis dar padengtas atskiru tvirtinimu.
- Jei abu punktai tenkinami — ataskaitoje rašyk ALREADY_IMPLEMENTED ir nieko nekeisk; jei ne — pridėk trūkstamą testą šiame faile.

## Patikra
- `pnpm test:file dist/tests/worktree-runtime-bootstrap.test.js`
- `pnpm test:only`

## Stop
Jei ALREADY_IMPLEMENTED — sustok be commit'o. Jei buvo pakeitimų — commit'ink tik kai abi patikros žalios, tada sustok.

## Neįtraukta
Produkcinio kodo keitimas; AG/config; benchmark provisioning kelias.
