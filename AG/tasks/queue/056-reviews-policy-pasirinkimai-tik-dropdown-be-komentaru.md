# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `PolicyControlsPanel` kortelėse nebėra „Available values" kodų juostelių,
rekomendacijos aiškinamųjų sakinių ir `HelpPopover`, o reikšmės pasirinkimas
vyksta per bendrą stilizuotą dropdown komponentą (custom trigger + listbox,
ne plikas naršyklės `<select>`) — ALREADY_IMPLEMENTED.

## Tikslas
Operatoriaus reikalavimas (2026-08-28) Reviews puslapiui:

1. Reikšmių pasirinkimai turi būti TIK dropdown — be jokių aiškinamųjų
   komentarų aplink. Dabar kiekviena kortelė rodo tris komentarų šaltinius:
   „Available values" kodų juosteles (dubliuoja dropdown'o turinį), du
   `small` sakinius prie „Recommended" ir `HelpPopover` („?") formoje —
   kortelė perkrauta, pasirinkimas išsklaidytas per tris vietas.
2. Išdėstymas turi būti profesionalus: kortelės tinklelis lygiuotas,
   vienodi tarpai, aiški hierarchija (pavadinimas → dabartinė reikšmė →
   nauja reikšmė → veiksmai), be inline `style` atributų.
3. Patys dropdown'ai — aukščiausios klasės dizaino, orientuojantis į
   geriausius tokio tipo pavyzdžius (Linear, Stripe Dashboard, Vercel
   Geist): custom trigger su chevron'u, popover listbox su pažymėto
   varianto ženkleliu, subtilus šešėlis, 6–8px radius, ryškus focus
   žiedas, hover būsenos, ~120ms atsidarymo animacija, pilnas klaviatūros
   valdymas.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/SelectMenu.tsx` (naujas)
- `ui-app/src/view/components/SelectMenu.test.tsx` (naujas)
- `ui-app/src/view/components/PolicyControlsPanel.tsx`
- `ui-app/src/view/components/PolicyControlsPanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `ui-app/src/App.tsx` (PolicyProposalsPanel — kitas blokas, neliečiamas)
- `ui-app/src/view/components/HumanReviewPanel.tsx`
- `ui-app/src/controller/**`
- `ui-app/src/model/api.ts`
- `src/**` (serverio kontraktas nesikeičia)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Naujas `SelectMenu` komponentas: valdomas (value/onChange/options/disabled),
  ARIA listbox šablonas — trigger `role="combobox"` + `aria-expanded` +
  `aria-activedescendant`, popover `role="listbox"`, variantai
  `role="option"`. Klaviatūra: ArrowUp/Down, Home/End, Enter/Space, Esc,
  Tab uždaro. Uždarymas paspaudus šalia. Jokių naujų dependencies —
  grynas React + CSS.
- Variantas gali turėti neprivalomą `tag` (pvz. „Recommended") — vienintelė
  leidžiama meta informacija, rodoma ženkleliu dropdown'o viduje, ne
  sakiniu kortelėje.
- `PolicyControlsPanel` pertvarka: pašalinti „Available values" bloką su
  kodų juostelėmis, abu `small` aiškinamuosius sakinius ir `HelpPopover`
  (kartu `CODING_PRINCIPLES_HELP` konstantą, jei nebelieka skaitytojų).
  Formos `<select>` keičiamas į `SelectMenu`; boolean nustatymai — irgi
  per `SelectMenu` (true/false variantai). Skaitiniai nustatymai be
  `allowed_values` lieka su `input` (dropdown'ui nėra iš ko rinktis).
  Rekomenduojama reikšmė žymima `tag` ženkleliu dropdown'e.
- Kortelės išdėstymas: `policy-value-guide` trijų stulpelių komentarų
  blokas keičiamas kompaktiška eilute „Current → New"; inline
  `style={{...}}` (jei liko) keliami į CSS klases.
- CSS: visos naujos className turi taisykles `dashboard.css`
  (`dashboard-css-coverage.test.ts` vartas); spalvos per esamus design
  token'us, veikia šviesioje ir tamsioje temoje.
- Nauji UI tekstai — per `t(...)` ir `I18nContext.tsx` žodyną.
- Testai: SelectMenu — atidarymas, pasirinkimas pele ir klaviatūra, Esc,
  aria atributai; PolicyControlsPanel — komentarų blokų nebėra, dropdown
  atiduoda pasirinktą reikšmę į `onPropose`, boolean nustatymas siunčia
  tikrą boolean.

## Patikra
- `pnpm typecheck && pnpm test`
- (apima `typecheck:ui` ir `test:ui` per šaknies vartus)

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
„Change reason" laukas LIEKA — pasiūlymo kontraktas reikalauja pagrindimo
(serveris jį valido; pašalinimas būtų public kontrakto keitimas, reikia
atskiro operatoriaus sprendimo). `HumanReviewPanel` veiksmų mygtukai lieka
mygtukais (patvirtinimo srautas — ne reikšmės pasirinkimas).
`PolicyProposalsPanel` ir `CompressionPage` `<select>` migracija į
`SelectMenu` — atskira užduotis, jei operatorius norės vienodo stiliaus
visur.
