# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 109-mobilus-meniu-grupuojamas-i-sekcijas-su-nustatymu-eilute

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/view/components/TokenUsageFilterBar.tsx` datos laukų blokas
šalia naršyklės valdomo lauko rodo faktinę pasirinktą reikšmę ISO
(`YYYY-MM-DD`) formatu ARBA pagalbinis tekstas performuluotas taip, kad
nebetvirtintų formato, kurio matomas laukas nerodo — ALREADY_IMPLEMENTED:
cituok JSX ir i18n tekstą kaip įrodymą.

## Tikslas
UI audito P3 (docs/audits/ui-app-2026-08-31/report.md, „LT datos laukai vis
dar rodo mm/dd/yyyy"): Analitikos formoje naršyklės datos laukai LT režime
vizualiai rodo `mm/dd/yyyy`, o pagalbinis tekstas tvirtina `YYYY-MM-DD` —
du vienu metu matomi formatai prieštarauja. Patikrinta 2026-09-01:
`ui-app/src/view/components/TokenUsageFilterBar.tsx` — 95 eil. komentaras
sąžiningai fiksuoja, kad garantuoti galima tik lauko REIKŠMĘ (visada ISO),
ne naršyklės picker'io išvaizdą; 121 eil. rodo pagalbinį tekstą
(I18nContext.tsx:377-378 „Dates are YYYY-MM-DD; the picker follows your
browser's language."). Naršyklės `input[type=date]` atvaizdavimo formato
nustatyti negalima — todėl sprendimas ne kovoti su picker'iu, o pašalinti
prieštarą pateikime: arba šalia lauko rodyti faktinę pasirinktą reikšmę ISO
formatu (tada abu formatai matomi kaip „įvestis vs kanoninė reikšmė", ne kaip
prieštara), arba performuluoti pagalbinį tekstą, kad jis kalbėtų apie
SIUNČIAMĄ reikšmę, o ne apie lauko išvaizdą. Kryptį pasirenka ir ataskaitoje
pagrindžia vykdytojas.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/TokenUsageFilterBar.tsx`
- `ui-app/src/view/components/TokenUsageFilterBar.test.tsx` (numatomas
  naujas — komponentas savo testo failo neturi; jei dengimas natūraliau gula
  `ui-app/src/view/pages/TokenUsagePage.test.tsx` — tas failas vietoje šio,
  įrašyti į ataskaitą)
- `ui-app/src/i18n/I18nContext.tsx` (pagalbinio teksto raktas keičiamas ar
  naujas ISO reikšmės etiketės raktas)
- `ui-app/src/view/styles/dashboard.css` (jei ISO reikšmės eilutei reikia
  naujos klasės)

Draudžiama:
- `ui-app/src/model/tokenUsageViewModel.ts` (`toInclusiveIsoDateBoundary` ir
  filtravimo logika teisinga — keičiasi tik pateikimas)
- `ui-app/src/controller/useTokenUsageController.ts` (filtrų būsena
  nekeičiama)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `TokenUsageFilterBar.tsx`: įgyvendinti pasirinktą kryptį — (a) po/šalia
  datos laukų rodyti faktines pasirinktas reikšmes ISO formatu (tuščios
  reikšmės nerodomos), arba (b) pagalbinį tekstą pakeisti formuluote apie
  siunčiamą reikšmę be tvirtinimo, kaip laukas ATRODO. Abiem atvejais LT ir
  EN tekstai keliauja per i18n.
- Jei keičiama esamo rakto EN sentinelė — atnaujinti VISUS jo naudojimus
  (raktas yra EN tekstas, tad keitimas reiškia seno rakto pašalinimą ir
  naujo įvedimą; i18n coverage testas tai gaudo).
- Testų lūkestis: (1) pasirinkus datą, prieštaraujančių formatų poros
  nebėra — arba rodoma ISO reikšmė šalia lauko, arba tekstas nebemini lauko
  išvaizdos formato; (2) esami filtravimo testai lieka žali.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
- Savo datos picker'io kūrimas vietoje naršyklinio — neproporcinga P3
  radiniui, o esamas komentaras (95 eil.) fiksuoja sąmoningą sprendimą
  pasikliauti naršykle.
- Kitų formų datos laukų auditas — report'as mini tik Analitikos formą.
