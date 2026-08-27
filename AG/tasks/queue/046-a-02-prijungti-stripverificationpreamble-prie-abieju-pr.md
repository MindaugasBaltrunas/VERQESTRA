# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Kiekvienas delegavimas privalo perrenderinti preambulę šviežią: requeue'intas task'as su sena „## Sandbox taisyklės" versija turi gauti tik naują. Prijungti jau esamą `stripVerificationPreamble` prie abiejų `verificationPreamble` kvietimo taškų — fastpath ir LLM keliai turi elgtis vienodai.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `src/tests/interfaces-cli-preflight.test.ts`

Draudžiama:
- `src/application/quality-gates/preflight-rules.ts`
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts`
- `src/application/task-planning/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- `index.ts`: abiejuose `verificationPreamble(...)` kvietimo taškuose (fastpath ~eil. 290 ir reformulate ~eil. 476) pirma paleisk `stripVerificationPreamble` ant task teksto, tada prilipdyk šviežią preambulę; importuok taisyklę iš to paties `quality-gates/preflight-rules.js` importo bloko.
- Nekeisk preambulės turinio, kelių logikos ar sekcijų validacijos — tik strip-then-render tvarką.
- `interfaces-cli-preflight.test.ts`: testai — task'as su sena preambule po delegavimo turi TIK naują (senų eilučių nebelieka, nauja viena kartą); task'as be preambulės elgiasi kaip iki šiol; abu keliai (fastpath ir reformulate) padengti.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei prireiktų keisti `preflight-rules.ts`, `spec-source.ts` arba migruoti senas preambules bucket'uose atgaline data — jos išsivalys natūraliai per kitą delegavimą.

## Neįtraukta
- Worker'io „deleguok ir baik turn'ą" elgesys ir Agent įrankio draudimas dispatch'e (operatoriaus sprendimas).
- 041-a-02 turinys — padarytas atskirai 2026-08-27.
