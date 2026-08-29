# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Registruoti `POST /api/runtime/worktree-policy` maršrutą, kuris kviečia jau egzistuojantį `setWorktreePolicyEnabled` iš `src/interfaces/http/ui-worktree-policy.ts`. Kūne priimamas TIK `{ "enabled": true|false }` — jokio kelio ar kito lauko iš request'o.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-router-mutations.ts`
- `src/interfaces/http/ui-router-model.ts`
- `src/tests/interfaces-http-worktree-policy-endpoint.test.ts`

Draudžiama:
- `src/interfaces/http/ui-worktree-policy.ts`
- `src/interfaces/http/ui-waves-view.ts`
- `src/composition/ui/router-adapters.ts`
- `src/application/scheduling/**`
- `dist/**`

## Veiksmas
- Coder: `ui-router-model.ts` — pridėti `WorktreePolicyPorts` lauką į router deps kaip OPCIONALŲ (toks pat šablonas kaip opcionalus portas `ui-waves-view.ts:174`), kad composition surišimas galėtų atsirasti atskirai ir build'as liktų žalias.
- Coder: `ui-router-mutations.ts` — maršrutą registruoti greta esamų `/api/runtime/...` mutacijų tuo pačiu `withJsonBody` šablonu; nevalidus kūnas → 400, sėkmė → `{ enabled, gitignore_ok }`; portams nesant maršrutas nesimatchina (grąžina `undefined`) kaip iki šiol.
- Reviewer: patikrinti, kad interfaces neimportuoja infrastructure ir kad abu paliesti failai lieka ≤500 eilučių.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei endpoint'ui prireiktų priimti kelią ar bet kurį kitą lauką iš request'o.

## Neįtraukta
Fs adapteriai composition sluoksnyje (kitas darbas). UI jungiklis. Politikos VARTOJIMAS scheduling sluoksnyje nekeičiamas.
