# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/022-stop-bridge-foreign-nonce-diagnosis-2026-08-25.md

## Tikslas
Uždaryti 021-d-05 seką regresiniu testu: bandymo N commit'as + vėlavęs bridge su N nonce, kai orkestratorius laukia N+1 nonce, nebegali baigti „clean tree without work evidence" repair ciklu.

## Agentai
Privaloma grandinė: readme-guard -> tester -> reviewer

## Failai
Leidžiama:
- `src/application/task-execution/stop-bridge-wait.ts`
- `src/tests/**`

Draudžiama:
- `src/infrastructure/state/stop-bridge.ts`
- `src/infrastructure/adapters/claude-dispatch-outcome.ts`
- `src/application/scheduling/slot-task-runner.ts`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Atkurk 021-d-05 seką testu per `stop-bridge-wait` portus (fake laikrodis ir fake bridge skaitytuvas, jokio realaus proceso): bandymas N palieka commit'ą, jo Stop hook'as bridge įrašo ~24 s vėliau, laukiama N+1 nonce.
- Tvirtink, kad darbo įrodymas išlieka — rezultatas nebėra tylus ignoravimas, o ankstesnių dviejų task'ų nustatytas elgesys.
- `stop-bridge-wait.ts` keisk tik jei testas atskleidžia realią spragą; kitu atveju failo neliesk.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok nedelsiant, jei testas praeina TIK susilpninus esamą laukimo kontraktą.

## Neįtraukta
- `stop-bridge.ts` ir `claude-dispatch-outcome.ts` keitimai (ankstesni task'ai).
- `slot-task-runner.ts` nonce valymo kontraktas.
- Realus queue loop paleidimas.
