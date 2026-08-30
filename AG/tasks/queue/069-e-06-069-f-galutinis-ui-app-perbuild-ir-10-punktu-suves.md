# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Po 069-a…069-e pataisymų perbuild'inti `ui-app`, kad `ui-app/dist` atspindėtų galutinį vaizdą, ir surinkti vieną suvestinę ataskaitą su visais 10 operatoriaus reikalavimų punktais (✅/❌ + `failas:eilutė`) bei naujais bundle hash'ais.

## Agentai
PRIVALOMA grandinė: readme-guard -> reviewer -> coder -> tester. readme-guard pirmas.

## Failai
Leidžiama:
- `ui-app/dist/**` (build artefaktas — visas bundle generuojamas iš naujo, todėl wildcard sąmoningas)

Draudžiama:
- `ui-app/src/**`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Paleisti `pnpm --dir ui-app build` ir užfiksuoti naujų bundle failų vardus su hash'ais.
- Surinkti 069-a…069-e ataskaitas į vieną suvestinę: 10 punktų, kiekvienas ✅/❌ su `failas:eilutė`.
- Suvestinės pabaigoje išvardyti didelius neatitikimus su siūlomais atskirais task'ais (įskaitant likusį `QueuePipelineBoard.tsx` / `queuePipelineViewModel.ts` be skaitytojo, jei jis vis dar yra).

## Patikra
- `pnpm --dir ui-app build`
- `pnpm test`

## Stop
Commit'ink, kai build žalias, `pnpm test` žalias ir suvestinėje visi 10 punktų pažymėti su naujais bundle hash'ais. Sustok, jei build raudonas — tai regresija iš ankstesnio vaiko, ne šio task'o pataisa.

## Neįtraukta
Bet koks `ui-app/src` redagavimas. Serverio kodas, mobile, dideli funkciniai pakeitimai.
