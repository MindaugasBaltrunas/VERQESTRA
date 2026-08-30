# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Prijungti jau egzistuojantį `src/infrastructure/git/preserved-ref-retention.ts` prie esamo orphan/priežiūros ciklo, kad pasenę `refs/verqestra/preserved/*` ref'ai ir jų `vq/state/rollback-preserved/*.json` įrašai būtų realiai šalinami. Ši užduotis priklauso nuo ankstesnės (retencijos modulis) — jei modulio dar nėra, sustok ir raportuok blokavimą.

Pirmiausia atlik Žingsnis 0: jei retencijos žingsnis jau kviečiamas iš priežiūros ciklo, sustok ir raportuok ALREADY_IMPLEMENTED su eilučių įrodymu.

## Agentai
Privaloma grandinė (ta pati eilės tvarka, be praleidimų):
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/command.ts`
- `src/composition/loop/preserved-work-adapters.ts`
- `src/tests/composition-preserved-work-wiring.test.ts`

Draudžiama:
- `src/infrastructure/git/preserved-ref-retention.ts`
- `src/interfaces/hooks/log-rotation.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Suriši retencijos žingsnį manual DI būdu prie esamo priežiūros/orphan ciklo `command.ts`, nekurdamas naujo ciklo ir nekeisdamas retencijos logikos.
- Retencijos N parų riba ateina per konfigūraciją su numatytąja 14, o ne hardcode'inta ciklo viduje.
- Testas: ciklo paleidimas kviečia retenciją su teisingais argumentais ir jos klaida nenutraukia likusio priežiūros ciklo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei prijungimas reikalautų keisti retencijos modulio public kontraktą.

## Neįtraukta
Retencijos vartų logikos keitimas. Ref'ų trynimas `rollback` metu. `git gc` orkestravimas. `hooks.log` rotacija. Eskalacijos sargas (074).
