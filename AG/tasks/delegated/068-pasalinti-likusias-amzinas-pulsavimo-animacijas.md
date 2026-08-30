## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus reikalavimas — jokių amžinų animacijų dashboard'e

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

## Veiksmas
- `.status-live::before` — `animation: pulse 1.4s ... infinite` (~462 eil.)
- `.workflow-card--running` — `animation: running-glow 2.2s ease-in-out
- Signalo taškas — `animation: pulse 1.3s ... infinite` (~3518 eil.)
