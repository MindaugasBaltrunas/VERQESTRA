# Task

## Spec source
openspec/changes/verqestra-backlog-v1 (task 067, 2/3 dalis; priklauso nuo 067 1/3)

## Tikslas
Atverti 'cancel' sprendima per HTTP: route regex `/api/policies/proposals/(approve|reject|apply|cancel)`, o application sluoksnio konfliktas ('applied' arba 'rejected' pasiulymas) grazinamas kaip 409 su paaiskinimu.

## Agentai
Privaloma naudoti butent sia grandine: readme-guard -> coder -> reviewer -> tester

## Failai
Leidziama:
- `src/interfaces/http/ui-router-mutations.ts`
- `src/tests/interfaces-http-router.test.ts`

Draudziama:
- `src/application/policy-governance/policy-proposal-service.ts`
- `ui-app/src/App.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Prideti 'cancel' i sprendimo route regex ir verb'o validacija; efektas gaunamas per esama porta, jokios naujos business logikos interfaces sluoksnyje.
- Application konflikto rezultata atvaizduoti i HTTP 409 su paaiskinimo tekstu; sekmingas atsaukimas - kaip kiti verb'ai.
- Testai: cancel grazina sekme pending/approved atveju, 409 applied/rejected atveju, nezinomas verb'as lieka atmestas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros zalios. Sustok, jei paaisketu, kad application sluoksnyje 'cancel' dar nera - tada blokuok, nes 1/3 dalis nebaigta.

## Neitraukta
Application logika ir zurnalo statusas (1/3 dalis). UI mygtukas, i18n, CSS, History zenklelis (3/3 dalis). Masinis atsaukimas.
