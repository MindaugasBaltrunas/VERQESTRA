# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/release-readiness/compression-quality-evidence.ts`
funkcijoje `checkCanaryGuardrails` (a) `cohortObservations` skaičiuojamas
tik iš įrašų, kurių `ts` nėra ankstesnis už lango atsidarymo žymę
(pvz. `arrestView.state.counters.human_review_window_opened_at` ar
analogišką canary įjungimo žymę), ir (b) feature „stebėta" patikra
(`records.some(... canary_features ...)`) taikoma tam pačiam
filtruotam poaibiui — ALREADY_IMPLEMENTED: cituoti filtravimo eilutes.

## Tikslas
2026-08-29 kompresijos posistemio auditas:
`src/application/release-readiness/compression-quality-evidence.ts:392`
(`checkCanaryGuardrails`) skaičiuoja `cohortObservations` per VISĄ istorinį
`context-size.jsonl` dabartiniu salt/percent — įrašai, parašyti IKI canary
įjungimo, pripučia skaitiklį, ir `canary-not-observed` warn'as (eil.
393–407) gali užsidegti iškart po įjungimo, nors kohorta dar neturėjo nė
vienos realios progos. Antra to paties radinio pusė: feature „stebėta"
įrodymas `records.some((record) => record.canary_features?.includes(feature))`
(eil. 398) priima įrašus iš senų salt kohortų.

Tai ta pati istorinio lango klaidų klasė, kurią 2026-08-29 arrest pusėje
uždarė `human_review_window_opened_at`
(`src/domain/policies/compression/arrest.ts:337–338` — žymė jau rašoma į
arrest state, o `checkCanaryGuardrails` jau gauna `arrestView` parametru,
eil. 350). Context-size įrašai turi `ts` lauką
(`src/application/context-pack/metrics.ts:195`), tad filtravimas pagal
laiką yra įmanomas be schemos keitimo.

Sprendimo kryptis: kohortos progos ir stebėjimo įrodymai skaičiuojami tik
nuo lango atsidarymo. Konkretus lango šaltinis (naudoti arrest markerio
`human_review_window_opened_at` kaip žymę filtruoti pagal įrašo `ts`, ar
įvesti atskirą canary įjungimo žymę) — architect sprendimas šio task'o
viduje; skaityti žymę iš jau paduodamo `arrestView`, ne iš naujo failo.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/release-readiness/compression-quality-evidence.ts`
- `src/tests/compression-quality.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `src/domain/policies/compression/arrest.ts` (lango žymė jau rašoma —
  nekeisti)
- `src/application/context-pack/metrics.ts` (`ts` laukas jau yra; schemos
  keitimo nereikia)

## Veiksmas
- `compression-quality-evidence.ts` / `checkCanaryGuardrails`: prieš
  `cohortObservations` skaičiavimą (eil. ~392) filtruoti `records` pagal
  lango žymę; tą patį filtruotą poaibį naudoti ir `watched` feature
  stebėjimo patikroje (eil. ~398).
- Elgesys be žymės (langas dar neatsidaręs / legacy state be lauko) —
  apibrėžti sąmoningai: skaitiklis startuoja nuo nulio, ne nuo visos
  istorijos; įrašų su tuščiu/nevalidžiu `ts` traktavimas — tolerantiškas
  (praleidžiamas, ne throw).
- Testų lūkestis (`compression-quality.test.ts`): (1) seni įrašai iki
  lango žymės nebedidina `cohortObservations` ir warn'as neužsidega iškart
  po įjungimo; (2) įrašai po žymės skaičiuojami kaip anksčiau; (3) sena
  salt kohortos `canary_features` žymė iki lango nebeįrodo „stebėta";
  (4) legacy state be žymės nesugriauna patikros.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad
`arrestView` neneša lango žymės tais keliais, kuriais `checkCanaryGuardrails`
realiai kviečiamas, ir žymei prireiktų naujo skaitymo kelio už
`compression-quality-evidence.ts` ribų.

## Neįtraukta
Arrest skaitiklio lango logika (`domain/policies/compression/arrest.ts`) —
pataisyta 2026-08-29 atskirai, neliečiama. Arrest kill-switch atribucija —
task 084 (nepriklausomas). Lango žymės rašymo pusės keitimas — nereikia,
žymė jau rašoma.
