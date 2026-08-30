# Task

UŽDARYTA KAIP KLAIDINGA PRIELAIDA: mindebaltru 2026-08-30 (atsakymas „b" į vykdytojo
stop klausimą). Šaka `worker-integration.ts:180` (`live.length === 0`) NĖRA nepasiekiama —
tai dokumentuotas fail-safe kontraktas: pačios funkcijos JSDoc (`worker-integration.ts:222-226`,
„NEPADUOTAS reiškia 'nežinome, kas dirba' — tokie iškviestėjai laukia tylos") ir tiesioginis
kontrakto testas `src/tests/scheduling-pool.test.ts:248-249`. Kodo darbo neatlikta ir nereikia;
šakos šalinimas ar „nepasiekiamumo" komentaras būtų faktiškai klaidingi.

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
`planIncrementalStep` sargas `worker-integration.ts:180` (`live.length === 0`) yra nepasiekiamas: kvietėjas visada paduoda bent vieną gyvą slot'ą (patį baigusįjį). Klaidinanti „gyva" blokavimo šaka pakeičiama assert'u arba komentaru, kuris įvardija nepasiekiamumą, kad kitas skaitytojas nebandytų jos dengti testu.

## Agentai
PRIVALOMA grandinė (ta pati eilės tvarka, be praleidimų): readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/worker-integration.ts`
- `src/tests/scheduling-wave-integration-coordinator.test.ts`

Draudžiama:
- `src/application/scheduling/wave-provisioning.ts`
- `src/application/scheduling/wave-scheduler.ts`
- `src/infrastructure/git/worktrees/worktree-owner.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: patvirtinti Grep'u, kad joks `planIncrementalStep` kvietėjas negali paduoti tuščio `live` masyvo, ir pasirinkti formą — invariantą įvardijantis komentaras ar `assert`.
- Coder: pakeisti šaką pagal architect'o sprendimą; kitos keturios blokavimo priežastys ir jų tekstai NEkeičiami.
- Tester: patikrinti, kad esami integracijos koordinatoriaus testai lieka žali ir kad nė vienas nesirėmė šia priežastimi.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei atsiranda kvietėjas, galintis paduoti tuščią `live` — tada tai gyva šaka ir jos liesti negalima.

## Neįtraukta
Kitos `planIncrementalStep` blokavimo priežastys. Write set sankirtos logika. Kiti 077 audito punktai — atskiri vaikai.
