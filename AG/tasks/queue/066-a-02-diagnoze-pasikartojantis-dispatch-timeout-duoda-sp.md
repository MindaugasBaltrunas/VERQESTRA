# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 073-registraciju-valymas-visuose-worktree-salinimo-keliuose
- 074-neintegruoto-w2-darbo-apsauga-po-proceso-luzio
- 078-worktree-bootstrap-buildstamp-ir-pnpm-path-spragos
- 079-orphan-valymas-iveikia-untracked-failus-ir-fs-liekanas
- 080-vaiko-exit-visada-palieka-diagnoze-ir-stderr

## Tikslas
Dabar pasikartojantis dispatch timeout (exit 124) su ta pačia retry-signature veda į human_review arba dar vieną retry — GeoGravity 1178 taip sudegino tris ciklus po ~100 min. Domain sluoksnyje reikia deterministinio sprendimo: kai timeout parašas kartojasi (>=2 bandymai), verdiktas yra `split`; `human-review` lieka fallback'u tik kai taskas nedalomas (1 veiksmas, 1 kelias).

## Agentai
PRIVALOMA grandinė be praleidimų: readme-guard -> architect -> schedule-domain -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/diagnosis/dispositions.ts`
- `src/tests/characterization-diagnosis.test.ts`

Draudžiama:
- `src/application/**`
- `src/interfaces/**`
- `dist/**`
- `ui-app/**`

## Veiksmas
- Įvesti gryną funkciją, kuri iš įėjimų (exit kodas, pasikartojančių to paties parašo bandymų skaičius, dalumo požymis) grąžina `split` | `human-review` | `repair`; jokio `node:` importo, jokio IO.
- Praplėsti verdiktų tipą 'split' reikšme taip, kad esami `LocalDiagnosisVerdict` / `NoCommitDisposition` skaitytojai liktų tipiškai teisingi.
- Testai: timeout×1 -> `repair`; timeout×2 su tuo pačiu parašu -> `split`; timeout×2 nedalomam task'ui -> `human-review`; esami charakterizavimo testai nepakitę.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei sprendimui prireiktų `node:` importo, IO porto arba application sluoksnio tipo — tai reikštų, kad logika ne domain'e.

## Neįtraukta
Maršruto pajungimas run-coordinator'yje, tėvo superseded žymėjimas ir žurnalo eilutė — kitas darbas. renderTaskPart commit_log pataisymas (jau atliktas).
