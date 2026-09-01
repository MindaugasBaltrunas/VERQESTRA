# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/worker-pool-plan.ts` `planSlotProvisioning`
hard-cap atsisakymo `detail` (dabar 257 eil.) nebeteigia „worker limitas jau
išduotas", o įvardija realią priežastį (šiame raunde laisvų indeksų nebėra /
liko vienas ir jį gavo ankstesnis kandidatas) — ALREADY_IMPLEMENTED: cituok
naują žinutę ir jos testą kaip įrodymą.

## Tikslas
W1/w2 slot'ų audito P2 (2026-09-01): pool'o `hard-cap` žinutė meluoja.
Patikrinta `worker-pool-plan.ts:245-259`: `nextFreeIndex =
input.plan.slots.length + 1` (245 eil.) — kai užimtas vienas slot'as, laisvas
indeksas yra LYGIAI VIENAS šiame raunde; PIRMAS missing-lease kandidatas jį
gauna (262-263 eil.), o visi likę krenta į `hard-cap` su detail „worker
limitas 2 jau išduotas — laisvo slot'o indekso nebėra" (257 eil.) — nors
NIEKAS dar neišduota: indeksas tik rezervuotas šiam raundui, o lease'ai bus
išduodami vėliau (`wave-provisioning.ts provisionMissingSlotLeases`).
Operatorius siunčiamas ieškoti pasenusių lease'ų, nors tai gryna šio raundo
aritmetika. Sprendimas: `detail` perrašyti į tiesą — pvz. „šiame raunde
laisvas tik vienas worker indeksas ir jis skirtas ankstesniam kandidatui" —
neliečiant paties skirstymo algoritmo (jis teisingas: deterministinė tvarka,
vienas indeksas raundui).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/worker-pool-plan.ts`
- `src/tests/scheduling-pool.test.ts`

Draudžiama:
- `src/application/scheduling/wave-provisioning.ts` (pakaitalo logika —
  task 114)
- `src/application/scheduling/worker-pool-admission.ts` (admission žinutės —
  task 116 kontekstas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `worker-pool-plan.ts` (`planSlotProvisioning`, 253-259 eil.): hard-cap
  `refusal.detail` perrašyti taip, kad jis skirtų dvi situacijas, jei jos
  atskiriamos iš turimų įėjimų: (a) `MAX_WORKERS` indeksai tikrai visi turi
  granted slot'us; (b) laisvas indeksas buvo, bet jį rezervavo ankstesnis šio
  raundo kandidatas. `reason` kodas `"hard-cap"` LIEKA — jį gali skaityti
  log parseriai, keičiasi tik žmogui skirtas `detail`.
- Testų lūkestis (`scheduling-pool.test.ts`): (1) du missing-lease kandidatai
  prie vieno granted slot'o — pirmas gauna indeksą, antro atsisakymo detail
  nebeteigia „jau išduotas", o įvardija raundo rezervaciją; (2) esami
  hard-cap testai atnaujinami pagal naują tekstą, nesilpninant reason kodo
  patikrų.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
- Kelių laisvų indeksų išdavimas viename raunde (algoritmo keitimas) —
  sąmoningas dizainas „vienas indeksas raundui" nekvestionuojamas be atskiro
  operatoriaus sprendimo.
- Provision nesėkmės pakaitalo paieška — task 114 (kitas failas, kita
  rizika).
- Pool eilutės missing-lease turtinimas — task 116.
