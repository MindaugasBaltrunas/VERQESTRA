# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 107-marsruto-pavadinimas-tampa-vieninteliu-h1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/view/components/WorkflowBoard.tsx` bucket kortelės antraštė
(dabar 109 eil. `<h3>{bucket.name}</h3>`) rodo verčiamą etiketę (per `t()` ar
etikečių žemėlapį), o techninis bucket vardas lieka tik `className`/valdymo
raktuose — ALREADY_IMPLEMENTED: cituok antraštės JSX ir etikečių šaltinį kaip
įrodymą.

## Tikslas
UI audito P2 (docs/audits/ui-app-2026-08-31/report.md, „LT režime vis dar
lieka mišrios produkto etiketės"): užduočių stulpeliai rodomi kaip `queue`,
`active`, `delegated`, `error`, `failed`, `human-review`, `done` — kodinis ID
ir vartotojo būsena atrodo vienodai. Patikrinta 2026-09-01: stulpelių
antraštės gyvena `ui-app/src/view/components/WorkflowBoard.tsx` `BucketCard`
— 109 eil. `<h3>{bucket.name}</h3>` renderina žalią bucket vardą be `t()`,
nors aprašymas šalia (110 eil.) verčiamas. Bucket vardas kartu yra TECHNINĖ
tapatybė: 105 eil. `workflow-card--${bucket.name}` klasė, `onOpenFolder`/
`onLoadTasks` argumentai — jos keisti negalima. Sprendimas pagal report:
matomą antraštę versti (LT — „Eilė", „Vykdoma", „Deleguota", „Klaida",
„Nepavykusios", „Žmogaus peržiūra", „Atlikta"; EN sentinelės — esami vardai),
o techninį raktą palikti valdymo keliuose nepakeistą; jei dizainas nori
rodyti ir techninį raktą — žymėti jį vizualiai kaip kodą (atskira klasė),
kad būsena ir ID nebeatrodytų vienodai.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/WorkflowBoard.tsx`
- `ui-app/src/view/components/WorkflowBoard.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx` (bucket etikečių raktai)
- `ui-app/src/view/styles/dashboard.css` (kodo žymėjimo klasė, jei rodomas
  techninis raktas)

Draudžiama:
- `ui-app/src/model/**` (bucket vardai duomenų kontrakte lieka techniniai)
- `src/**` (serverio bucket semantika neliečiama)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `WorkflowBoard.tsx`: bucket antraštė (109 eil.) renderinama per verčiamą
  etiketę — EN sentinelė gali būti pats bucket vardas, kad EN režimas liktų
  bit-identiškas; LT gauna vertimus. `className` (105 eil.) ir visi valdymo
  kvietimai (`onOpenFolder(bucket.name)`, `onLoadTasks(bucket.name)`) TOLIAU
  naudoja techninį vardą — vertimas tik pateikimo sluoksnyje.
- Testų lūkestis (`WorkflowBoard.test.tsx`): (1) LT režime stulpelio
  antraštė lietuviška; (2) `workflow-card--<name>` klasė ir `onOpenFolder`
  argumentas lieka techninis vardas; (3) EN režimo antraštės nepakitusios.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
- Kitų ekranų anglicizmų (`worker`, `lease`, `prompt`, `canary`, `dispatch`,
  `default`) inventorius ir vertimas — report'as pažymi, kad dalis jų yra
  TIKRI techniniai identifikatoriai, tad pirmiau reikia inventoriaus su
  klasifikacija „verstina būsena vs kodas"; tai atskiras task'as, kad šis
  neliestų pusės komponentų medžio.
- Bucket vardų keitimas duomenų/API lygyje — jie yra katalogų vardai
  (`AG/tasks/<bucket>`), kontraktas.
