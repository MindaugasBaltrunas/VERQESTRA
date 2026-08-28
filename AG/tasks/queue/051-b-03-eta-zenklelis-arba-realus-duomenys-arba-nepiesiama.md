# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
`SlotProgressCard.tsx:134` visada piešia `EtaBadge`, bet `DashboardPage.tsx:69-79` `etas` neperduoda — `resolveEta(undefined)` visada grąžina `{state:"unavailable"}`, tad kiekvienoje srauto kortelėje kabo negyvas valdiklis. Reikia vieno sprendimo: arba `etas` perduodamas iš `DashboardPage`, arba `EtaBadge` nepiešiamas, kol šaltinio nėra.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/SlotProgressCard.tsx`
- `ui-app/src/view/components/SlotProgressCard.test.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`

Draudžiama:
- `src/**`
- `ui-app/src/model/api.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Nustatyk, ar `DashboardPage` prieinamuose duomenyse ETA šaltinis apskritai egzistuoja; jei taip — perduok `etas` iki kortelės, jei ne — nepiešk `EtaBadge`, kol `etas` neperduotas.
- Pasirinktą sprendimą pagrįsk komentaru prie pakeitimo (kodėl būtent šis, o ne antras variantas).
- Testuose padenk abi būsenas: su ETA duomenimis ženklelis rodomas, be jų — kortelėje jo nėra.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei ETA duomenims reikėtų naujo API lauko arba `ui-app/src/model/api.ts` keitimo — tai backend'o darbas ir į šią užduotį neįeina.

## Neįtraukta
ETA skaičiavimo backend'as. LoopControls W1/W2 (ankstesnės užduotys). Drain/abort mygtukai (050).
