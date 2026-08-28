# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
`LoopControls.tsx:91-101`: W1 mygtukas numatytoje būsenoje (`requested === 1`) visada `disabled`, bet jo `title` žada „The base stream — always on while the loop runs. Click to keep only W1." — tooltip žada veiksmą, kurio mygtukas neleidžia. Aktyvus pasirinkimas turi būti rodomas kaip BŪSENA (pažymėtas), o tooltip turi atitikti realią galimybę. Kartu mygtukai piešiami iš viewmodel pasirinkimų sąrašo, ne iš vietinės `WORKER_CHOICES` konstantos.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/LoopControls.tsx`
- `ui-app/src/view/components/LoopControls.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`

Draudžiama:
- `src/**`
- `ui-app/src/model/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Pakeisk `WORKER_CHOICES` konstantą ankstesnėje užduotyje pridėta `loopControlsViewModel` pasirinkimų funkcija; mygtukai renderinami iš jos rezultato.
- Segmented-control elgesys: pažymėtas pasirinkimas lieka paspaudžiamas (arba `aria-pressed` + nedisabled), o `disabled` paliekamas TIK kai pasirinkimas realiai neprieinamas (`canEdit=false`, pending, arba viršija `max`) — tooltip tada nurodo tikrąją priežastį.
- Naujus tooltip/priežasčių raktus pridėk į `I18nContext.tsx` (be jų `i18n/coverage.test.ts` raudonas); testuose padenk max=1 atvejį: W2 neprieinamas su teisinga priežastimi.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei paaiškėtų, kad reikia keisti `loopControlsViewModel.ts` kontraktą — grįžk į ankstesnę užduotį, o ne taisyk čia.

## Neįtraukta
EtaBadge srauto kortelėse (kita užduotis). Drain/abort mygtukai (050).
