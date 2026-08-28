# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `GET /api/compression` view'e kiekviena vėliava jau neša priklausomybės
informaciją (`requires` + ar ji šiuo metu tenkinama), o `CompressionPage`
`compact_dsl` jungiklį rodo neaktyvų arba su įspėjimu „requires
worker_task_ir", kol `worker_task_ir` yra `false` — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-28 operatorius Kompresijos puslapyje įjungė `compact_dsl`, kai
`worker_task_ir` buvo `false`. Serveris konfigą priėmė, bet efektyvus konfigas
vėliavą priverstinai išjungia (`resolveCompressionFeatureDependencies`,
`src/domain/policies/compression/dependencies.ts:23` — compact DSL renderina
WorkerTaskIR, be IR nėra ko renderinti). Rezultatas: puslapis rodo
`compact_dsl=true` kaip „good", nors dispatch'ai jos nevykdo; vienintelis
signalas — `COMPRESSION CONFIG DEPENDENCY` eilutės orchestrator.log'e, kurių
operatorius UI nemato. Puslapis leidžia išsaugoti konfigą, kuris garantuotai
nieko nedaro, ir nepasako to išsaugojimo momentu.

Sprendimas — rodyti, NE numanomai įjunginėti: numanomas `worker_task_ir`
įjungimas sulipdytų A/B priskyrimą (dvi vėliavos matuojamos atskirai) ir
paslėptų arešto priežastingumą. Priklausomybių lentelė lieka domain'e;
view tik ją atspindi.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-compression-view.ts`
- `src/tests/ui-compression-view.test.ts`
- `src/tests/interfaces-http-compression.test.ts`
- `ui-app/src/model/types.ts`
- `ui-app/src/view/pages/CompressionPage.tsx`
- `ui-app/src/view/pages/CompressionPage.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/domain/policies/compression/dependencies.ts` (taisyklė teisinga, jos nekeisti)
- `src/domain/policies/compression/features.ts`
- `src/application/context-pack/effective-compression-policy.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- View pusė: `ui-compression-view.ts` kiekvienai vėliavai iš
  `COMPRESSION_FEATURE_DEPENDENCIES` (import iš domain — interfaces → domain
  leidžiamas) prideda opcionalius laukus: `requires` (ko vėliava reikalauja)
  ir `inactive_reason` (užpildoma, kai deklaruota reikšmė ne `false`, o
  privaloma vėliava efektyviame konfige `false`). Skaičiuoja SERVERIS —
  puslapis niekada neperskaičiuoja (puslapio taisyklė nr. 1).
- UI pusė: `CompressionPage.tsx` vėliavos eilutėje, kai `inactive_reason`
  yra: (a) „Current" badge rodomas ne `status-good`, o `status-error` arba
  `neutral` su tekstu „inactive"; (b) po hint'u — įspėjimo eilutė
  „requires worker_task_ir — the flag is saved but has no effect until it
  is enabled". Jungiklio NEblokuoti (operatorius turi galėti paruošti
  konfigą iš anksto) — blokavimas paslėptų deklaruotą reikšmę.
- Nauji UI tekstai — per `t(...)` ir `I18nContext.tsx` žodyną; naujos
  className turi turėti taisyklę `dashboard.css`
  (`dashboard-css-coverage.test.ts` vartas).
- Testai: view testas — `compact_dsl=true` + `worker_task_ir=false` →
  `inactive_reason` užpildytas; `worker_task_ir=true` → laukas nebūna.
  Puslapio testas — įspėjimas matomas tik neaktyviai vėliavai.

## Patikra
- `pnpm typecheck && pnpm test`
- (apima `typecheck:ui` ir `test:ui` per šaknies vartus)

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Numanomas `worker_task_ir` įjungimas (sąmoningai atmestas — A/B priskyrimas
ir arešto priežastingumas). Priklausomybių lentelės keitimas. Kitų vėliavų
semantika. `canary` reikšmės priklausomybės vertinimas per task kohortą
(view vertina tik deklaruotą konfigą, ne per-task kohortą — pakanka
operatoriaus sprendimui).
