# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Audituoti dashboard punktus 8 ir 9:
8. Sprendimų eilėje yra „Atšaukti" veiksmas su `cancelled` statusu.
9. Dashboard rodo ABU slot'us: `AgentChainProgress` w2 juosta, „Aktyvus vykdymas" abu workeriai, `OverviewPanel` w2 signalai.
Kiekvieną punktą pažymėti ✅/❌ su `failas:eilutė` įrodymu. Priklauso nuo 069-a.

## Agentai
PRIVALOMA grandinė: readme-guard -> reviewer -> coder -> tester. readme-guard pirmas.

## Failai
Leidžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/pages/DashboardPage.test.tsx` (numatomas vardas — tikslus dar nežinomas, failo gali nebūti)
- `ui-app/src/view/components/OverviewPanel.tsx`
- `ui-app/src/view/components/OverviewPanel.test.tsx` (numatomas vardas — tikslus dar nežinomas, failo gali nebūti)
- `ui-app/src/view/components/AgentChainProgress.tsx`
- `ui-app/src/view/components/AgentChainProgress.test.tsx`
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/i18n/I18nContext.tsx`

Draudžiama:
- `ui-app/src/model/**`
- `ui-app/src/controller/**`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Grep `w2`, `cancelled`, `Atšaukti` per leidžiamus failus; patvirtinti, kad abu slot'ai renderinami ir kad atšaukimo veiksmas egzistuoja.
- Read `AgentChainProgress.tsx` ir `OverviewPanel.tsx`: patikrinti, ar w2 juosta ir w2 signalai nėra hardcode'inti tik w1 keliui.
- Ataskaitoje pažymėti punktus 8 ir 9 su `failas:eilutė`; trūkstamą i18n raktą ar CSS taisyklę TIK įrašyti, NETAISYTI.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios ir punktai 8, 9 pažymėti su įrodymais. Sustok, jei trūksta viso w2 duomenų kelio — tai didelis neatitikimas: ataskaita su siūlomu atskiru task'u, ne pataisa.

## Neįtraukta
CSS ir i18n pataisymai (069-a). SystemStatusHero ir RuntimePanel (069-b). WavesPanel, LoopControls (069-c). Reviews forma (069-d). Galutinis build (069-f). Serverio kodas, mobile.
