# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Surišti `POST /api/ui/rebuild` portą su tikru proceso paleidimu tuo pačiu šablonu kaip loop start, kad endpoint'as veiktų gyvai.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/ui/lifecycle-adapters.ts`
- `src/composition/ui/router-adapters.ts`
- `src/tests/composition-ui-rebuild-wiring.test.ts` (naujas)

Draudžiama:
- `src/interfaces/**`
- `src/application/**`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Jei rebuild portas jau surištas — ALREADY_IMPLEMENTED, sustok.
- Surišk rebuild proceso paleidimą per esamą `ProcessLifecyclePorts` adapterį; komanda ateina iš interfaces, composition jos nekeičia ir nepriima iš request'o.
- Teste padenk: pirmas prašymas `started`, antras lygiagretus `already-running`, nesėkmė grąžina `failed` su išvesties uodega.

## Patikra
- `pnpm typecheck && pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei testui reikėtų realaus `pnpm build` paleidimo — spawn turi būti stub'inamas.

## Neįtraukta
UI mygtukas, indikatoriaus rodymas, i18n, CSS — 058-b. Automatinis perbuild'as po loop task'ų, websocket auto-reload.
