# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus nurodymas — build valdymas turi būti mygtuku iš panelės

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei dashboard'e yra mygtukas, kuris per serverio endpoint'ą paleidžia
`pnpm --dir ui-app build`, ir UI įspėja, kai servuojamas `ui-app/dist`
yra senesnis už `ui-app/src` — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-28 operatorius du kartus žiūrėjo į pasenusį dashboard'ą: loop'o
task'ai keitė `ui-app/src`, bet serveris atiduoda statinį `ui-app/dist`,
o perbuild'as buvo rankinis terminalo žingsnis, apie kurio būtinybę UI
niekaip nepasako. Operatoriaus nurodymas: šis veiksmas turi būti valdomas
mygtuku iš panelės.

Du pokyčiai:
1. **Indikatorius**: serveris prie UI view prideda `bundle_stale` faktą
   (naujausio `ui-app/src` failo mtime > `ui-app/dist/index.html` mtime)
   ir `bundle_built_at`. UI, kai bundle pasenęs, rodo aiškų įspėjimą su
   veiksmu, ne tylų seną ekraną.
2. **Mygtukas**: „Perbuild'inti dashboard'ą" (System puslapyje prie ciklo
   valdymo) → POST endpoint'as, kuris serveryje paleidžia
   `pnpm --dir ui-app build` tuo pačiu proceso paleidimo šablonu, kaip
   `/api/runtime/loop/start` (`process-lifecycle-ports`). Būsena rodoma:
   vykdoma → pavyko (siūlo Ctrl+F5 / auto-reload) → klaida su išvestimi.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-rebuild.ts` (naujas)
- `src/interfaces/http/ui-router.ts`
- `src/interfaces/http/ui-router-mutations.ts`
- `src/interfaces/http/ui-router-model.ts`
- `src/interfaces/http/ui-port-store.ts`
- `src/composition/ui/router-adapters.ts`
- `src/composition/ui/lifecycle-adapters.ts`
- `src/tests/interfaces-http-ui-rebuild.test.ts` (naujas)
- `src/tests/interfaces-http-router.test.ts`
- `ui-app/src/model/api.ts`
- `ui-app/src/model/types.ts`
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/application/**` (proceso paleidimas — interfaces/composition lygis,
  kaip loop start; jei architect nuspręs kitaip — stop ir klausk)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: endpoint'o kontraktas (`POST /api/ui/rebuild`, būsenos
  atsakymas), staleness skaičiavimo vieta ir apsauga nuo lygiagrečių
  build'ų (vienas vykstantis build; antras prašymas gauna „jau vyksta").
- Coder: endpoint + view laukai + mygtukas su trimis būsenomis; klaidos
  atveju rodoma build išvesties uodega.
- Saugumo riba: endpoint'as paleidžia TIK fiksuotą komandą
  `pnpm --dir ui-app build` — jokių parametrų iš request'o.

## Patikra
- `pnpm typecheck && pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Automatinis perbuild'as po kiekvieno loop task'o (atskiras sprendimas —
galbūt orchestratoriaus post-task žingsnis, ne UI). Naršyklės auto-reload
per websocket — užtenka įspėjimo ir mygtuko.
