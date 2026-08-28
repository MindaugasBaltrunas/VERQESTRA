# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Patvirtinti, kad worktree layout kompozicijoje perduoda visą `vq/config` katalogą per `configDirs`, kad vaiko procesas rastų `tool-budget.json`. Jei taip — ALREADY_IMPLEMENTED be rašymų.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/command.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-runtime.ts`
- `src/application/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Patikrink, ar layout eilutėse šalia `configFiles` yra `configDirs` su config katalogu, išreikštu santykiniu keliu nuo `projectRoot` ir POSIX skirtukais.
- Patikrink, ar `configFiles` su `local.env` liko vietoje (paritetas dėl suderinamumo).
- Jei abu punktai tenkinami — ataskaitoje rašyk ALREADY_IMPLEMENTED ir nieko nekeisk; jei ne — pataisyk tik layout eilutes.

## Patikra
- `pnpm typecheck`
- `pnpm lint`

## Stop
Jei ALREADY_IMPLEMENTED — sustok be commit'o. Jei buvo pakeitimų — commit'ink tik kai abi patikros žalios, tada sustok.

## Neįtraukta
Infrastructure layout tipas ir kopijavimo logika; testų padengimas; AG/config; benchmark provisioning kelias.
