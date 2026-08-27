# Task

## Spec source
- `AG/openspec/changes/auto-032-shadow-matuoja-prompta-kuri-worker-realiai-gau/spec.md`

## Tikslas
`decideCompression` sprendimą priima pagal prompt'o lygio shadow porą, kai ji mėginiuose YRA; kai nėra — lieka dabartinis elgesys (fallback, ne lūžis). Slenksčio logika nesikeičia.

## Agentai
Privaloma grandinė: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-compression-view.ts`
- `src/tests/ui-compression-view.test.ts`

Draudžiama:
- `src/application/context-pack/metrics.ts`
- `src/application/context-pack/assemble/persist.ts`
- `ui-app/**`
- `AG/**`
- `vq/**`

## Veiksmas
- `decideCompression` skaito naujus prompt'o lygio laukus, kai jie mėginyje yra; kai nėra — grįžta prie dabartinės poros be lūžio.
- `MIN_DECISION_SAMPLES` ir spaudimo lygių slenksčiai lieka nepakeisti.
- Verdikto rezultate matomas laukas, kuris pora buvo naudota, kad UI galėtų įvardyti KAS lyginama.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei fallback'as reikalautų keisti slenksčių semantiką arba lūžtų esami skaitytojai.

## Neįtraukta
- Telemetrijos laukų rašymas (ankstesnis task'as).
- UI sakiniai `ui-app` (kitas task'as).
