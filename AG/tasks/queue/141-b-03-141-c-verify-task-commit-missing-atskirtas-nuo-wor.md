# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 141-a-02-141-b-dispositions-sava-priezastis-atvejui-rasymai

> 2026-09-03 pataisyta: priklausomybė buvo proza („141-b (dispositions priežasčių
> tekstai …)"), ne task id, tad planuoklė ją laikė `missing-dependency` ir
> užblokavo bangą (`LOOP STOP: all-blocked`, 09:51). Tikrasis tėvas yra `done`.

## Tikslas
verify-task re-check žinutėje atskirti „commit missing (executor wrote files, tree dirty)" nuo „work missing (no write-tool calls)", kad human-review įrašas iš karto rodytų, ar problema hook'e, ar darbo iš viso nebuvo.

## Agentai
PRIVALOMA grandinė, tokia tvarka: readme-guard -> debugger -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/task-execution/verify-task.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `src/domain/diagnosis/dispositions.ts`
- `src/interfaces/hooks/on-stop.ts`
- `src/interfaces/hooks/on-stop-context.ts`
- `src/infrastructure/state/task-state-store.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Perduok į verify-task žinutę 141-b priežasties kodą ir suformuok dvi skirtingas human-review žinutes: „commit missing" ir „work missing".
- Neplėsk priėmimo logikos: keičiasi tik įvardijimas ir žinutės turinys, ne verdiktas.
- Testuose padenk abu kelius: rašymai buvo be commit'o, ir rašymų nebuvo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei žinutės skirčiai prireiktų naujo lauko diagnozės kontrakte.

## Neįtraukta
- Stop hook'o commit kelias ir dispositions tekstai — ankstesni task'ai.
- Vaiko human-review verdikto propagacija — 135.
