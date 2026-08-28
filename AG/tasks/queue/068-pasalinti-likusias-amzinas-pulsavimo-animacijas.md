# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus reikalavimas — jokių amžinų animacijų dashboard'e

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 065-b-ui-w2-slotas-dashboardo-blokuose
- 066-policy-forma-be-privalomos-priezasties-ir-selectmenu-poliravimas
- 067-sprendimu-eileje-pasiulyma-galima-atsaukti

## Žingsnis 0 — ar jau įgyvendinta?
Jei `dashboard.css` neturi nė vienos `animation: ... infinite` taisyklės,
išskyrus laukimo indikatorius (`button-spin` spinner'į ir `skeleton-sweep`
krovimosi skeletą) — ALREADY_IMPLEMENTED.

## Tikslas
Operatorius 059-c pašalino begalinę progreso juostą, bet liko trys amžinos
pulsuojančios animacijos, prieštaraujančios reikalavimui „jokių amžinų
animacijų":

1. `.status-live::before` — `animation: pulse 1.4s ... infinite` (~462 eil.)
2. `.workflow-card--running` — `animation: running-glow 2.2s ease-in-out
   infinite` + `@keyframes running-glow` (~1806–1811 eil.) — tai tas
   „lakstantis/švytintis" efektas ant vykdomos kortelės
3. Signalo taškas — `animation: pulse 1.3s ... infinite` (~3518 eil.)

Pakeisti statiniais indikatoriais: „gyva/vykdoma" būseną rodo spalva,
rėmelis ir (taškui) pastovus šešėlio žiedas — be jokio judesio. Nenaudojami
`@keyframes` (`pulse`, `running-glow`) išimami, kad neliktų mirusio CSS.

PALIEKAMA sąmoningai: `button-spin` (spinner'is vykstančio veiksmo metu) ir
`skeleton-sweep` (krovimosi skeletas) — jie rodo realų, baigtinį laukimą ir
yra įprasta konvencija. Įėjimo animacijos (`card-enter`, `state-morph`) —
vienkartinės, ne amžinos, jų neliesti.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `ui-app/src/**/*.tsx` (klasės lieka tos pačios — keičiasi tik jų CSS)
- `dist/**`
- `node_modules/**`

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Spinner'is ir skeleton'as (lieka). Vienkartinės įėjimo animacijos (lieka).
Komponentų logika.
