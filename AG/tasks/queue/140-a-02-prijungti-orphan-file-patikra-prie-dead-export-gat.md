# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- Reikalinga `src/tests/helpers/dead-export-gate-scan.ts` su `collectImportSpecifiers` / `resolveSpecifier` / `findOrphanFiles` (ankstesnė šio skėlimo užduotis). Jei helper'io nėra — sustok ir pranešk.

## Tikslas
Prijungti failų lygio našlaičių patikrą prie realaus `dead-export-gate.test.ts` varto: produkcinis src failas, kurio kelio neimportuoja nė vienas kitas src failas ir kuris nėra aiškiame entrypoint allowlist'e, yra pažeidimas `orphan-file`.

## Agentai
PRIVALOMA grandinė: readme-guard -> debugger -> coder -> reviewer -> tester. readme-guard pirmas.

## Failai
Leidžiama:
- `src/tests/dead-export-gate.test.ts`

Draudžiama:
- `src/tests/helpers/dead-export-gate-scan.ts`
- `src/tests/dead-export-gate-orphan-scan.test.ts`
- `src/application/code-intelligence/store/code-index-store.ts`
- `src/infrastructure/index.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `collect` (~208-232 eil.) papildomai išsaugo kiekvieno failo neapdorotą šaltinį arba jo specifikatorius per `collectImportSpecifiers`; naujas testas „gate: kiekvienas produkcinis failas turi importuotoją arba yra entrypoint" kviečia `findOrphanFiles` ir kiekvieną radinį praneša kaip `orphan-file` su failo vardu.
- `KNOWN_ENTRYPOINTS`: aiškus komentuotas sąrašas `KNOWN_UNCALLED` (~249-284 eil.) stiliumi — bent `cli.ts` (dist/cli.js yra bin ir hook'ų kvietimo taškas); kiekvienas kitas kandidatas TIK su priežasties komentaru, dviejų krypčių drausmė ta pati: atsiradęs importuotojas daro eilutę nebeteisingą.
- Failas privalo likti ≤ 500 eilučių (dabar 359) — jei netelpa, skenavimo dalį kelk į jau egzistuojantį helper'į, ne į naują failą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok ir klausk, jei patikra ras realių našlaičių, kurių trynimas nėra akivaizdžiai saugus (pvz. kelią mini konfigas ar ne-TS kodas) — tokio failo likimas yra operatoriaus sprendimas, ne baseline eilutė „kad praeitų". Tylus praleidimas draudžiamas.

## Neįtraukta
- Grynos skenavimo logikos ir jos savipatikros keitimas (ankstesnės užduoties scope)
- Bet kokių rastų našlaičių trynimas — sandbox trynimo neatlieka, reikia operatoriaus veiksmo
