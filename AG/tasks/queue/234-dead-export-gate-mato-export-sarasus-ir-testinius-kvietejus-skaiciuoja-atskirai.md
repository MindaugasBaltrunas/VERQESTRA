# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/dead-export-gate.test.ts` eksportų regex'ai atpažįsta `export { a, b }`, `export default`
ir `export let|enum` formas, o vartas (`gate: kiekvienas produkcinis eksportas…`) testinius kvietėjus
skaičiuoja ATSKIRAI (testas neprikelia eksporto) ir `KNOWN_*` reikšmes validuoja pagal uždarą žodyną —
ALREADY_IMPLEMENTED: cituok regex'us ir vartų asercijas.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, T1; `scratchpad/audit-tests.md` §4):
`dead-export-gate.test.ts:199-200` atpažįsta tik `export function|const|class`, o produkcijoje yra 23
`export { … }` sąrašai per 14 failų (`composition/ui/router-adapters.ts:339`,
`application/quality-gates/preflight.ts:230`, `infrastructure/persistence/task-graph-store.ts:203`, …) —
mirusiam eksportui nereikia net `KNOWN_UNCALLED` eilutės. `:394` testą laiko kvietėju, nors antraštė
(5-7 eil.) sako, kad vartas gimė iš „testais apkabintas, composition neprijungė" — būtent tą atvejį jis
laiko gyvu (`reconcilePreservedRefs`, `applyIntegrationPlan`, `appendStateHistory`, `uiRebuildStatus`,
`identityFingerprint`, `isDistRebuildCommand`, `isMaintenancePath`, `createIntegrationPlan`,
`runWaveGates`, `measureParallelOverhead`, `decideRetryOrRepair`). `KNOWN_UNCALLED`/`KNOWN_ENTRYPOINTS`
reikšmės (`Record<string,string>`) netikrinamos — tinka bet koks tekstas; trys įrašai
(`readTokenAnalyticsSnapshot`, `auditBacklogDirectory`, `ecmascriptExtensions`, 287-290 eil.) turi
nebegaliojančią priežastį. Trynimas — atskirų sričių task'ai; čia vartas ir jo žodynas.

## Agentai
readme-guard -> tester -> reviewer

## Failai
Leidžiama:
- `src/tests/dead-export-gate.test.ts`
- `src/tests/helpers/dead-export-gate-scan.ts` (tik jei eksportų formų atpažinimą verta iškelti į bendrą helper'į)

Draudžiama:
- `src/application/**` (miręs kodas šiuo task'u NETRINAMAS — tik surašomas)
- `src/composition/**`
- `src/infrastructure/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Eksportų surinkimas: prie `EXPORTED_FUNCTION`/`EXPORTED_BINDING` pridėti `export { a, b as c }` sąrašus
  (be `from` — re-eksportai lieka failų lygio vartui), `export default <vardas>`, `export let|enum|var`;
  testas su visomis formomis vienoje eilutėje/keliose eilutėse.
- Kvietėjų skaičiavimas: `production`-kvietėjas gyvina; `tests`-kvietėjas NEBEGYVINA — jis tik
  atskiria `NEPRIJUNGTA` (turi testų) nuo `MIRĘS` (neturi nieko) klaidos žinutėje; token'inis sutapimas
  lieka (antraštėje įvardyta riba), bet pridedamas testas, kad `import { x }` teste be kvietimo neprikelia.
- `KNOWN_UNCALLED`/`KNOWN_ENTRYPOINTS` reikšmės validuojamos uždaru žodynu
  (`FORWARD | NEPRIJUNGTA | ŠEIMA | BIN | BARELIS`, plius laisvas komentaras po `:`); svetima reikšmė — raudona.
- Po pakeitimo išlindusiems eksportams įrašyti `KNOWN_UNCALLED` su `NEPRIJUNGTA` ir vieno sakinio
  priežastimi (kas turėtų prijungti: pvz. `uiRebuildStatus` → task 223, `identityFingerprint` → 225,
  `reconcilePreservedRefs`/`quarantineStaleDist` — atskiri task'ai); trims pasenusiems įrašams priežastį
  perrašyti pagal dabartinę būseną.
- Testai: `stripComments`+regex vienetiniai atvejai kiekvienai naujai formai; gate'o „appeared/disappeared"
  asercijos nekinta prasme; `pnpm test` žalias su pilnu žodynu.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Kiti task'ai (163–222, 223, 225) lygiagrečiai prijungia
`quarantineStaleDist`, `reconcilePreservedRefs`, `uiRebuildStatus`, `identityFingerprint` ir kt.: jei
simbolis vykdymo metu JAU turi produkcinį kvietėją arba jo `KNOWN_UNCALLED` įrašas jau dingęs — įrašo
NEDĖK ir neatstatyk. Stop ir klausk, jei išlindusių eksportų daugiau nei 40 — tada žodyno pildymas be
peržiūros virstų „senų pateisinimų muziejumi", kurį antraštė draudžia.

## Neįtraukta
- Mirusių simbolių trynimas (`measureParallelOverhead`, IVER grandinė, `decideRetryOrRepair`, …) — sričių
  task'ai pagal audito „Miręs kodas" sąrašą; šis task'as juos tik įvardija.
- Failų lygio našlaičių skenas (`dead-export-gate-orphan-scan.test.ts`) — nekeičiamas.
- Type-only eksportai — sąmoningai už varto ribų (žr. testo 187-198 eil.).
