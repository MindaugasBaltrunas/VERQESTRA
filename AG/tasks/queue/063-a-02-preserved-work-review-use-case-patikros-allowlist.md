# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Sukurti application use-case, kuris ant materializuoto preserved darbo paleidžia task'o `## Patikra` komandas (arba quality-gates scope) ir įvertina, ar pakeisti failai telpa į task'o allowlist. Grąžina verdiktą, ne veiksmą.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/preserved-work-review.ts`
- `src/application/task-execution/preserved-work-review-model.ts`
- `src/tests/task-execution-preserved-work-review.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`
- `src/infrastructure/**`
- `src/composition/**`

## Veiksmas
- Deklaruok portą preserved darbo materializavimui ir komandų paleidimui; jokio tiesioginio `node:child_process` ar git iškvietimo application sluoksnyje.
- Verdiktas `recovered` tik kai VISOS patikros exit 0 IR visi pakeisti keliai telpa į allowlist; kitu atveju `needs-human` su patikrų uodega ir preserved ref nuoroda.
- Testai: žalios patikros + allowlist OK → `recovered`; raudona patikra → `needs-human` su uodega; failas už allowlist ribų → `needs-human` net esant žalioms patikroms.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok, jei prireiktų antro LLM kvietimo — patikros yra deterministinės komandos.

## Neįtraukta
Verify-task sprendimo šaka ir composition surišimas — sekančios užduotys.
