# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 076-rollback-be-nonce-nebeliecia-svetimo-necommitinto-darbo (application sluoksnio dalis: `taskScopeRestorePaths` foreign/skipped atskyrimas)

## Žingsnis 0 — ar jau įgyvendinta?
Jei `rollback-stable` išvestyje jau yra sekcija, išvardijanti dėl svetimos savininkystės praleistus kelius — ALREADY_IMPLEMENTED su eilučių įrodymu.

## Tikslas
Uždaryti audito P1 matomumo pusę: rollback'as, praleidęs svetimos sesijos ar nenustatomos savininkystės kelius, tai pasako operatoriui. Tylus praleidimas yra tokia pat spraga kaip tylus revertas — operatorius turi matyti, kad medyje liko neliestas svetimas necommit'intas darbas.

## Agentai
Privaloma grandinė (be praleidimų): readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/bootstrap/rollback-stable.ts`
- `src/tests/interfaces-cli-rollback-stable.test.ts`

Draudžiama:
- `src/application/task-execution/session-write-owners.ts`
- `src/infrastructure/git/rollback-scope.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: nustatyti, kaip praleistų kelių sąrašas pasiekia CLI esamu portu, nekeičiant `rollback-scope.ts`; jei portas to neleidžia — sustoti ir raportuoti, ne plėsti scope.
- Coder: praleistus kelius su priežastimi (`foreign` / `unknown-owner`) išvesti kartu su atstatytų kelių ataskaita, tuo pačiu kanalu kaip esamas užblokuoto rollback'o pranešimas (stderr + AG žurnalas).
- Tester: rollback su bent vienu svetimu ir vienu be savininkystės keliu → abu išvardyti ataskaitoje ir NEatstatyti; be praleistų kelių ataskaita nesikeičia.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Testų nesilpninti. Sustok, jei reikėtų liesti `rollback-scope.ts` ar application sluoksnį.

## Neįtraukta
Application sluoksnio savininkystės taisyklė (pirmasis task'as). `rollback-scope.ts` mechanika. Preserved ref'ų retencija (075). UI.
