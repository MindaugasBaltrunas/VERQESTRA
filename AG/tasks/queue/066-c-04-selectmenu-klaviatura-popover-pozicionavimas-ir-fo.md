# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
SelectMenu policy formos kortelėje veikia profesionaliai: pele ir klaviatūra, be popover'io apkirpimo, su teisingu fokusu ir ARIA. Priėmimo kriterijai tikrinami formos KONTEKSTE (kortelėje), ne izoliuotai.

## Agentai
Privaloma grandinė (nenukrypti): readme-guard -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `ui-app/src/view/components/SelectMenu.tsx`
- `ui-app/src/view/components/SelectMenu.test.tsx`
- `ui-app/src/view/components/PolicyControlsPanel.test.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `ui-app/src/view/components/PolicyControlsPanel.tsx`
- `ui-app/src/model/api.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Klaviatūra: Enter/Space atidaro, Esc uždaro ir grąžina fokusą į trigger'į, ArrowUp/Down + Enter renkasi; `aria-expanded` visada atitinka būseną.
- Popover'is neapkerpamas kortelės `overflow` (pozicionavimas + z-index), užsidaro paspaudus šalia ir suskrolinus; focus žiedas matomas abiejose temose.
- Testai: SelectMenu vienetiniai + formos kontekste, kad pasirinkta reikšmė pasiekia `onPropose` kaip tikras boolean (ne "true" tekstas).

## Patikra
- `pnpm --dir ui-app build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios (CSS klasių dengiamumo vartas turi likti žalias). Sustok, jei taisymui reikėtų keisti `PolicyControlsPanel.tsx` ar SelectMenu public props kontraktą.

## Neįtraukta
Priežasties lauko šalinimas (jau atlikta ankstesnėje užduotyje). Kiti Reviews blokai. Pasiūlymų atšaukimas (067).
