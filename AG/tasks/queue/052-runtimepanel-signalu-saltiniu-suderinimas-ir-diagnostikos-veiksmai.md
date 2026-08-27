# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei „Automatika laukia" kortelė ir jos mygtukas skaito TĄ PATĮ būsenos šaltinį
(nesutapimas paaiškinamas tekstu, o ne amžinai disabled mygtuku), „Valdymo
sąsaja nepasiekiama" nebežymima critical pačioje veikiančioje sąsajoje, o
„Automatikos politika" lentelės komanda matoma ir nukopijuojama —
ALREADY_IMPLEMENTED.

## Tikslas
2026-08-27 UI auditas: (a) `RuntimePanel.tsx:168` kortelę rodo pagal
`processes`, o jos mygtuko leidimą skaičiuoja iš `loopControl`
(`:106-114`, `loopControlsViewModel.ts:98-103`) — šaltiniams nesutapus kortelė
kviečia veikti su amžinai išjungtu mygtuku be paaiškinimo. (b) `overall =
ui?.status !== "running" ? "critical"` (`RuntimePanel.tsx:120,136`) — jei PID
sekiklis nemato „AG UI" proceso, ekranas tvirtina, kad valdymo sąsajos nėra,
nors operatorius į ją žiūri; UI įrašo nebuvimas turi būti degraded su
paaiškinimu, ne critical. (c) `DiagnosticsPanel.tsx:50-75` „Automatikos
politika": vienintelis veiksmas (`control.command`) paslėptas `title` atribute
ant `<code>` (`:68`) — padaryti matomą komandą su copy mygtuku. (d) Per-proceso
„Tikrinti dar kartą" (`RuntimePanel.tsx:178-184`) N kopijų kviečia tą patį
globalų `reload()` — palikti VIENĄ mygtuką sekcijai.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/view/components/DiagnosticsPanel.tsx`
- `ui-app/src/view/components/DiagnosticsPanel.test.tsx`
- `ui-app/src/model/loopControlsViewModel.ts`
- `ui-app/src/model/loopControlsViewModel.test.ts`
- `ui-app/src/i18n/I18nContext.tsx`

Draudžiama:
- `src/**`
- `ui-app/src/model/api.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Kortelės rodymo sąlygą ir mygtuko leidimą išvesti iš to paties šaltinio;
  nesutapimo atveju rodyti priežastį tekstu.
- UI proceso nebuvimą žymėti degraded (ne critical) su paaiškinimu.
- Politikos komandą rodyti kaip matomą `<code>` bloką su „Kopijuoti" mygtuku.
- Vienas „Tikrinti dar kartą" visai unknown procesų sekcijai.
- Testai: šaltinių nesutapimo scenarijus rodo paaiškinimą.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios.

## Neįtraukta
PID sekiklio (`src/**`) logika. Feedback per run() (048).
