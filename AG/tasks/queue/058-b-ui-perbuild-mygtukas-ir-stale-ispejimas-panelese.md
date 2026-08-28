# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus nurodymas — build valdymas turi būti mygtuku iš panelės (rankinis skėlimas: čia UI dalis, serverio dalis — 058)

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 058-ui-perbuild-mygtukas-ir-pasenusio-bundle-indikatorius

## Žingsnis 0 — ar jau įgyvendinta?
Jei `#/system` puslapyje yra mygtukas „Perbuild'inti dashboard'ą" su
būsenomis vykdoma/pavyko/klaida ir įspėjimas, kai `bundle_stale` — 
ALREADY_IMPLEMENTED. Jei serverio `POST /api/ui/rebuild` dar neegzistuoja
(058 nebaigtas) — STOP: praneškit, kad priklausomybė dar neįvykdyta.

## Tikslas
UI pusė dashboard'o perbuild valdymui (serverio endpoint'ą daro 058):

1. **Įspėjimas apie pasenusį bundle**: kai view atsakyme `bundle_stale`,
   System puslapyje rodomas aiškus notice: „Rodomas dashboard'as senesnis
   už šaltinius" su mygtuku perbuild'inti — daugiau jokio tylaus seno
   ekrano.
2. **Mygtukas „Perbuild'inti dashboard'ą"** RuntimePanel ciklo valdymo
   juostoje: paspaudus POST `/api/ui/rebuild`; būsenos: vykdoma (mygtukas
   disabled su priežastimi) → pavyko (siūlo perkrauti puslapį) → klaida
   (rodo build išvesties uodegą). „Jau vyksta" atsakymas rodomas kaip
   vykdoma, ne kaip klaida.

Dizaino kartelė kaip 059: aiškios būsenos, jokių amžinų animacijų, abi
temos, tekstai per `t(...)`.

## Agentai
readme-guard -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/model/api.ts`
- `ui-app/src/model/types.ts`
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**` (serverio dalis — 058)
- `ui-app/src/controller/**`
- `dist/**`
- `node_modules/**`

## Patikra
- `pnpm typecheck && pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Serverio endpoint'as ir staleness skaičiavimas (058). Automatinis
perbuild'as. Websocket auto-reload — užtenka pasiūlymo perkrauti.
