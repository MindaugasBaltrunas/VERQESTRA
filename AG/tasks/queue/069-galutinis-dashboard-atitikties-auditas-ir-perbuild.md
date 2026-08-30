# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus užsakymas — dashboard turi pasiekti 10/10 pagal dienos reikalavimų sąrašą

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 073-registraciju-valymas-visuose-worktree-salinimo-keliuose
- 074-neintegruoto-w2-darbo-apsauga-po-proceso-luzio
- 078-worktree-bootstrap-buildstamp-ir-pnpm-path-spragos
- 079-orphan-valymas-iveikia-untracked-failus-ir-fs-liekanas
- 080-vaiko-exit-visada-palieka-diagnoze-ir-stderr
- 065-b-ui-w2-slotas-dashboardo-blokuose
- 066-policy-forma-be-privalomos-priezasties-ir-selectmenu-poliravimas
- 067-sprendimu-eileje-pasiulyma-galima-atsaukti
- 068-pasalinti-likusias-amzinas-pulsavimo-animacijas

## Žingsnis 0 — ar jau įgyvendinta?
Šis task'as yra PATIKROS auditas — jis vykdomas visada, kai priklausomybės
baigtos. ALREADY_IMPLEMENTED netaikomas; rezultatas — ataskaita + šviežias
`ui-app/dist`.

## Tikslas
Galutinė 2026-08-28 operatoriaus reikalavimų atitikties patikra. Kiekvieną
punktą patikrinti KODE (grep/Read) ir pažymėti ataskaitoje ✅/❌ su failo
eilute kaip įrodymu:

1. `#/system` viršuje — SystemStatusHero su vykdoma užduotimi ir veiksmu.
2. Vidinės detalės — `<details className="system-panel-details">` blokuose.
3. Tuščios lentelės įvardija priežastį (worktree politikos būsena WavesPanel).
4. Ciklo mygtukai turi `title` priežastis; drain subtekstas prie „Stabdyti".
5. Jokio `QueuePipelineBoard` ir jokių jo liekanų (CSS/i18n).
6. Perbuild mygtukas + `bundle_stale` įspėjimas RuntimePanel.
7. Reviews: jokių „Available values"/„Recommended" komentarų, SelectMenu su
   ARIA; JOKIO „Change reason (required)" lauko.
8. Sprendimų eilėje yra „Atšaukti" veiksmas (cancelled statusas).
9. Dashboard rodo ABU slot'us: AgentChainProgress w2 juosta, „Aktyvus
   vykdymas" abu workeriai, OverviewPanel w2 signalai.
10. `dashboard.css` be amžinų animacijų (išskyrus spinner/skeleton).

Radus smulkų neatitikimą (trūkstamas i18n raktas, likusi CSS taisyklė be
skaitytojo, trūkstamas `title`) — taisyti ČIA, leidžiamų failų ribose.
Radus DIDELĮ neatitikimą (trūksta viso bloko/funkcijos) — NETAISYTI, o
įrašyti į ataskaitą su siūlomu atskiru task'u.

Pabaigoje PRIVALOMA: `pnpm --dir ui-app build`, kad `ui-app/dist`
atspindėtų galutinį vaizdą, ir ataskaitoje nurodyti nauju bundle hash'us.

## Agentai
readme-guard -> reviewer -> coder -> tester

## Failai
Leidžiama (tik smulkiems pataisymams pagal auditą):
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/pages/CompressionPage.tsx`
- `ui-app/src/view/components/SystemStatusHero.tsx`
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/WavesPanel.tsx`
- `ui-app/src/view/components/LoopControls.tsx`
- `ui-app/src/view/components/OverviewPanel.tsx`
- `ui-app/src/view/components/AgentChainProgress.tsx`
- `ui-app/src/view/components/PolicyControlsPanel.tsx`
- `ui-app/src/view/components/SelectMenu.tsx`
- `ui-app/src/App.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**` (serverio pusė — tik skaityti; neatitikimas ten = ataskaita, ne
  pataisa)
- `ui-app/src/controller/**`
- `ui-app/src/model/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Kiekvieną iš 10 `## Tikslas` punktų patikrinti kode (grep/Read) ir
  ataskaitoje pažymėti ✅/❌ su `failas:eilutė` įrodymu.
- Smulkius neatitikimus (trūkstamas i18n raktas, CSS taisyklė be skaitytojo,
  trūkstamas `title`) taisyti leidžiamų failų ribose; didelius — NETAISYTI,
  įrašyti į ataskaitą su siūlomu atskiru task'u.
- Pabaigoje `pnpm --dir ui-app build`; ataskaitoje nurodyti naujus bundle
  hash'us.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios ir ataskaitoje visi 10 punktų pažymėti.

## Neįtraukta
Dideli funkciniai pakeitimai (tik ataskaita). Serverio kodas. Mobile.
