# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Audituoti dashboard punktus 1, 2 ir 6:
1. `#/system` rodinio viršuje yra `SystemStatusHero` su vykdoma užduotimi ir veiksmu.
2. Vidinės detalės suvyniotos į `<details className="system-panel-details">` blokus.
6. `RuntimePanel` turi perbuild mygtuką ir `bundle_stale` įspėjimą.
Kiekvieną punktą pažymėti ✅/❌ su `failas:eilutė` įrodymu. Priklauso nuo 069-a (bendri CSS/i18n resursai jau sutvarkyti).

## Agentai
PRIVALOMA grandinė: readme-guard -> reviewer -> coder -> tester. readme-guard pirmas.

## Failai
Leidžiama:
- `ui-app/src/view/components/SystemStatusHero.tsx`
- `ui-app/src/view/components/SystemStatusHero.test.tsx`
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/App.tsx`
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/i18n/I18nContext.tsx`

Draudžiama:
- `ui-app/src/model/**`
- `ui-app/src/controller/**`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Read `App.tsx` `#/system` maršrutą ir `SystemStatusHero.tsx`: patvirtinti, kad hero yra viršuje ir rodo vykdomą užduotį bei veiksmą.
- Grep `system-panel-details` ir `bundle_stale` per leidžiamus failus; patikrinti, ar detalės yra `<details>` blokuose ir ar perbuild mygtukas su `bundle_stale` įspėjimu egzistuoja.
- Smulkius neatitikimus (trūkstamas `title`, netikslus `aria-*`) taisyti čia; trūkstamą i18n raktą ar CSS taisyklę TIK įrašyti į ataskaitą kaip 069-a tęsinį, NETAISYTI.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios ir punktai 1, 2, 6 pažymėti su `failas:eilutė` įrodymais. Sustok, jei trūksta viso bloko ar funkcijos — tai didelis neatitikimas: įrašyk į ataskaitą su siūlomu atskiru task'u.

## Neįtraukta
CSS ir i18n pataisymai (069-a). WavesPanel, LoopControls (069-c). Reviews forma (069-d). Slotai ir sprendimų eilė (069-e). Galutinis build (069-f). Serverio kodas, mobile.
