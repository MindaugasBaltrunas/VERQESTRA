# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/wave-integration-ports.ts` tipas
`WaveIntegrationPorts` (šiandien 60-78 eil.) turi telemetrijos surinkimo
portą (pvz. `collectWorktreeTelemetry`), o
`src/application/scheduling/wave-integration-step.ts` funkcijoje `run`
jis kviečiamas PRIEŠ `ports.cleanupWorktree` (šiandien 220 eil.) —
ALREADY_IMPLEMENTED: cituok porto tipą, kvietimo eilutę ir realizaciją
`src/composition/loop/wave-integration-adapters.ts` kaip įrodymą.

## Tikslas
Canary matavimai miršta kartu su worktree. Įrodymas (2026-09-01,
operatoriaus diagnozė): dispatch vaikas worktree'e rašo
`vq/logs/context-size.jsonl` ir `vq/logs/token-usage.jsonl` į SAVO kopiją
(patikrinta: `.ag/worktrees/<run>/w1-138-.../vq/logs/context-size.jsonl`
egzistuoja), o `vq/` yra gitignored (`.gitignore:11`), tad merge jų
neperneša, o sėkminga integracija worktree ištrina kartu su telemetrija
(`wave-integration-step.ts:220` → `cleanupWorktree` →
`wave-integration-adapters.ts:159-186` → `removeTaskWorktree`).
Pagrindinio medžio `vq/logs/context-size.jsonl` paskutinis dispatch
įrašas — 2026-09-01 08:29 (paskutinis pagrindinio medžio dispatch'as);
visa vėlesnė worktree era matavimų nepaliko. Pasekmė: kompresijos canary
kohortų (`symbol_slices`, `dispatch_tool_schema` —
`src/application/analytics/compression-cohorts.ts`) naudos vertinimas ir
`verqestra report` kohortų sekcija liko be imties — klausimas „ar verta
įjungti kompresiją" neatsakomas duomenimis.

Sprendimo kryptis: integracijos žingsnis prieš worktree pašalinimą
APPEND'ina vaiko telemetrijos eilutes į pagrindinio medžio atitinkamus
failus su dedup'u. Atmesta alternatyva — vaikui rašyti tiesiai į
pagrindinio medžio `vq/logs`: izoliacija yra sąmoninga (lygiagretūs W1/W2
rašytojai lenktyniautų dėl to paties failo, o vaikas gautų rašymo kanalą
už savo kopijos ribų).

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/wave-integration-ports.ts`
- `src/application/scheduling/wave-integration-step.ts`
- `src/composition/loop/wave-integration-adapters.ts`
- `src/tests/scheduling-wave-integration-coordinator.test.ts`
  (`WaveIntegrationIo` stub 349 eil. + step elgesio tvirtinimai)
- `src/tests/scheduling-wave-scheduler.test.ts` (`WaveIntegrationIo`
  stub 51 eil. — naujas privalomas portas jį palies)
- `src/tests/composition-wave-integration-adapters.test.ts`
  (adapterio dedup/trūkstamo failo/neparsinamos eilutės atvejai)

Draudžiama:
- `src/composition/loop/command.ts` (146 queue scope; adapterio
  `WaveIntegrationAdapterDeps` NEplečiami — pagrindinio medžio `vq/logs`
  kelias vedamas iš `deps.projectRoot`, ta pačia konvencija kaip
  `src/composition/runtime/integration-adapters.ts:235`)
- `src/application/scheduling/worker-integration.ts` (plano semantika —
  kada ir ką integruoti — nekeičiama)
- `src/infrastructure/git/worktrees/worktree-removal.ts` (pašalinimo
  taisyklės nekeičiamos — surinkimas vyksta PRIEŠ, ne vietoje)
- `src/infrastructure/state/token-usage-log.ts` ir
  `src/application/context-pack/metrics.ts` (rašymo pusė lieka kaip yra)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `wave-integration-ports.ts`: naujas `WaveIntegrationPorts` portas, pvz.
  `collectWorktreeTelemetry: (input: { worktreePath: string; task_id:
  string }) => Promise<{ appended: number; detail: string }>` su
  komentaru, kad portas NIEKADA nemeta ir NIEKADA neblokuoja
  integracijos (ta pati taisyklė kaip `safeLog`/`safeEvent`).
- `wave-integration-step.ts` `run`: kviesti portą tarp `settleTaskFile`
  ir `ports.cleanupWorktree` (parkavimo kelias worktree palieka, tad ten
  surinkimo nereikia). Nesėkmė ar išimtis → VIENA `safeLog` eilutė
  (pvz. `INTEGRATION TELEMETRY HARVEST FAILED: ...`), integracija
  tęsiasi nepakitusi.
- `wave-integration-adapters.ts`: realizacija — iš
  `<projectRoot>/<step worktree kelias>/vq/logs/context-size.jsonl` ir
  `.../token-usage.jsonl` perskaityti eilutes ir APPEND'inti į
  pagrindinio medžio `<projectRoot>/vq/logs/` atitikmenis su dedup'u
  pagal jau esamą unikalų raktą (pvz. `ts`+`task_id`+`attempt_id`;
  eilučių formos šaltiniai — `src/domain/tokens/usage-ledger.ts` ir
  `src/application/context-pack/metrics.ts`), kad requeue ar pakartotinė
  integracija nedubliuotų. Failo nėra → `appended: 0` be klaidos;
  neparsinama eilutė → praleidžiama su detale `detail` lauke; jokių
  išimčių aukštyn.
- Testų lūkesčiai: (1) step kviečia surinkimą prieš `cleanupWorktree`,
  o jo nesėkmė nekeičia integracijos baigties ir nesukelia parkavimo;
  (2) adapterio pakartotinis kvietimas su tomis pačiomis eilutėmis
  grąžina `appended: 0` (dedup); (3) trūkstamas vaiko failas ir
  neparsinama eilutė — tylus praleidimas su log detale; (4) abiejų
  scheduler testų `WaveIntegrationIo` stub'ai atnaujinti.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei porto surišimas
neišsiverčia be `src/composition/loop/command.ts` pakeitimo (jis 146
queue scope — tada reikia operatoriaus sprendimo dėl priklausomybės)
arba jei dedup'ui neužtenka esamų eilučių laukų ir reikėtų keisti pačių
rašytojų formą.

## Neįtraukta
- Parkuotų (human-review) worktree'ų telemetrija — jų kopijos lieka
  diske neištrintos, tad duomenys neprarandami; surinkimas įvyks per
  būsimą to task'o integraciją. Atskiras task'as kuriamas tik jei
  parkuotų kopijų valymo politika atsiras.
- Istoriniai jau ištrintų worktree'ų matavimai — atkurti neįmanoma;
  kohortų imtis pradės augti tik nuo šio pakeitimo.
- Telemetrijos rašytojų (`token-usage-log.ts`, `context-pack/metrics.ts`)
  ir kohortų skaičiavimo (`compression-cohorts.ts`) keitimai — šis
  task'as tik perneša eilutes į vietą, kurią skaitytojai jau mato.
