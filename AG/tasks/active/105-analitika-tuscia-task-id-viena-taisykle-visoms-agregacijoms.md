# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 104-politikos-forma-neleidzia-siusti-nepakeistos-reiksmes

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/model/tokenUsageViewModel.ts` turi VIENĄ tuščio `task_id`
normalizavimo funkciją, kurią naudoja ir `aggregateTokenUsage` (task_id
grupavimas), ir `computeTokenUsageTotals`, ir iš jų maitinamos distribucijos —
t. y. tuščias ID traktuojamas VIENODAI visose agregacijose —
ALREADY_IMPLEMENTED: cituok normalizavimo funkciją ir jos kvietėjus kaip
įrodymą.

## Tikslas
UI audito P1 (docs/audits/ui-app-2026-08-31/report.md, „Analitika nesutaria
dėl užduočių skaičiaus"): tame pačiame rinkinyje rodoma „UNIKALIOS UŽDUOTYS:
139", lentelės suvestinė „140 užduočių" ir du skirtingi tokenų/užduočiai
vidurkiai (3 781 829 vs 3 754 816); paskutiniame puslapyje — tuščio ID grupė
su 161 įrašu. Šaknis patikrinta 2026-09-01
`ui-app/src/model/tokenUsageViewModel.ts`: `computeTokenUsageTotals` tuščią
`task_id` į `uniqueTasks` NEĮTRAUKIA (162 eil., su 2026-08-24 pamokos
komentaru 157-161 eil.), bet `aggregateTokenUsage` grupuodama pagal
`task_id` ima žalią `record[groupBy]` (73 eil.) — tuščia eilutė tampa atskira
grupe, kuri patenka į lentelę (`TopTasksTable.tsx:89` — „140 užduočių") ir į
grupių pagrindu skaičiuojamus vidurkius, bet ne į KPI kortelę
(`TokenUsageSummaryPanel.tsx:36-37`). Report rekomendacija: VIENA
normalizavimo taisyklė prieš visas agregacijas — tuščias ID arba atmetamas
visur, arba visur rodomas kaip „Nepriskirta"; jo negalima skirtingai traktuoti
to paties ekrano KPI. Vykdytojas pasirenka kryptį ir sprendimą fiksuoja
ataskaitoje (rekomenduojama „Nepriskirta" — 2026-08-24 pamoka rodo, kad tylus
atmetimas irgi slepia signalą apie nepriskirtą telemetriją).

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/model/tokenUsageViewModel.ts`
- `ui-app/src/model/tokenUsageViewModel.test.ts`
- `ui-app/src/view/pages/TokenUsagePage.tsx`
- `ui-app/src/view/pages/TokenUsagePage.test.tsx`
- `ui-app/src/view/components/TokenUsageSummaryPanel.tsx`
- `ui-app/src/view/components/TopTasksTable.tsx`
- `ui-app/src/view/components/TopTasksTable.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx` (raktas „Nepriskirta" krypčiai, jei ji
  pasirenkama)
- `ui-app/src/view/styles/dashboard.css` (jei „Nepriskirta" eilutė žymima
  nauja klase)

Draudžiama:
- `src/**` (telemetrijos rašytojai — tuščias task_id yra teisėtas įrašas,
  problema tik UI agregacijų nesutarime)
- `ui-app/src/model/apiEnvelopes.ts` (duomenų kontraktas nekeičiamas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `tokenUsageViewModel.ts`: viena eksportuota normalizavimo funkcija (pvz.
  `normalizeTaskId`), taikoma PRIEŠ visas task_id agregacijas:
  `aggregateGroupKey` (57-74 eil.), `computeTokenUsageTotals` (162 eil.) ir
  visur, kur iš grupių skaičiuojami vidurkiai/distribucijos. Pasirinkta
  kryptis (atmesti visur AR „Nepriskirta" visur) taikoma nuosekliai:
  `uniqueTasks`, lentelės grupių skaičius ir abu vidurkiai skaičiuojami iš
  TOS PAČIOS aibės.
- Jei kryptis „Nepriskirta": grupės etiketė verčiama per i18n, o techninė
  grupės tapatybė lieka stabili (ne vertimo tekstas — rikiavimas ir raktai
  negali priklausyti nuo kalbos).
- Testų lūkestis: rinkinys su tuščio `task_id` įrašais — (1) `uniqueTasks` ir
  task_id grupių skaičius sutampa (139≠140 klasės regresija); (2) tokenai
  vienai užduočiai, skaičiuojami iš totals ir iš grupių, sutampa; (3) esami
  2026-08-24 pamokos testai lieka žali.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad tuščio ID
traktavimo kryptis keičia serverio pusės kontraktą (pvz. eksportuojamą CSV ar
API formą) — tai jau ne UI agregacijų klausimas.

## Neįtraukta
- Telemetrijos rašytojų keitimai, kad tuščias `task_id` neatsirastų — įrašai
  be užduoties yra teisėta fazių telemetrija.
- `phase`/`model`/`day` grupavimo normalizacija — problemų neužfiksuota.
- „naujausi 500 iš 795" dalinio rinkinio semantika — auditas ją įvertino
  teigiamai.
