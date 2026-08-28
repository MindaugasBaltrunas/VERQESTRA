# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Surišti ankstesnėje dalyje deklaruotą bundle portą su tikru fs adapteriu: `ui-app/dist/index.html` mtime ir naujausio `ui-app/src` failo mtime.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/ui/router-adapters.ts`
- `src/tests/composition-ui-bundle-staleness.test.ts` (naujas)

Draudžiama:
- `src/interfaces/**`
- `src/application/**`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Jei `router-adapters.ts` jau tiekia bundle mtime faktus — ALREADY_IMPLEMENTED, sustok.
- Įgyvendink adapterį: skaityk `ui-app/dist/index.html` mtime ir rekursyviai naujausią `ui-app/src` failo mtime; trūkstamas kelias grąžina `null`, o ne meta klaidą.
- Teste padenk tris atvejus: bundle šviežias, bundle pasenęs, bundle nesukurtas.

## Patikra
- `pnpm typecheck && pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei paaiškėja, kad portas ankstesnėje dalyje nedeklaruotas.

## Neįtraukta
UI view laukai (jau padaryti), rebuild endpoint'as, rebuild proceso wiring, UI mygtukas (058-b).
