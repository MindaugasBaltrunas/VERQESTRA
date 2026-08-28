# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
`POST` policy propose endpoint'as priima pasiūlymą be `reason` (arba su tuščiu) ir įrašo `reason: ""`. Prieš tai application sluoksnis jau atlaisvintas. Operatoriaus patvirtintas kontrakto pakeitimas (2026-08-28).
Jei endpoint'as jau priima kūną be `reason` — ALREADY_IMPLEMENTED, nieko nekeisk.

## Agentai
Privaloma grandinė (nenukrypti): readme-guard -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/interfaces/http/ui-router-mutations.ts`
- `src/tests/composition-ui-policy-governance.test.ts`

Draudžiama:
- `src/application/policy-governance/policy-proposals-log.ts`
- `ui-app/src/model/api.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Propose šakoje `reason` nebeprivalomas: trūkstamas ar tuščias virsta `""`; 400 lieka tik dėl `setting_id`, klaidos tekstas atitinkamai patikslinamas; JSDoc apie klientą atnaujinamas.
- Decision (approve/reject/apply) šaka NEKEIČIAMA — ten `reason` lieka kaip buvo.
- `src/tests/composition-ui-policy-governance.test.ts`: testas, kad kūnas be `reason` grąžina sėkmę ir įrašo `reason: ""`, o kūnas be `setting_id` toliau 400.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei tektų keisti application schemą ar decision kelio kontraktą.

## Neįtraukta
UI forma ir SelectMenu. Decisions `reason`. Pasiūlymų atšaukimas (067).
