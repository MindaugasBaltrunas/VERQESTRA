# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Prijungti jau egzistuojantį `ui-worktree-policy.ts` modulį prie HTTP: `POST /api/runtime/worktree-policy` su kūnu `{ "enabled": true|false }` (jokių kitų parametrų iš request'o), ir composition sluoksnyje suteikti tikrus fs adapterius — tiek mutacijai, tiek `readWorktreeGitignoreOk` portui waves view.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-router-mutations.ts`
- `src/interfaces/http/ui-router-model.ts`
- `src/composition/ui/router-adapters.ts`
- `src/tests/interfaces-http-worktree-policy-endpoint.test.ts` (numatomas naujas; dengia
  `ui-router-mutations.ts` naują `POST /api/runtime/worktree-policy` maršrutą ir
  `ui-router-model.ts` route tipo papildymą; jei testas gyvena kitur — tas failas vietoje šio,
  įrašyti į ataskaitą)
- `src/tests/composition-worktree-policy-wiring.test.ts` (numatomas naujas; dengia
  `router-adapters.ts` naujus fs adapterius politikos rašymui ir `.gitignore` skaitymui; jei
  testas gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/interfaces/http/ui-worktree-policy.ts`
- `src/interfaces/http/ui-waves-view.ts`
- `src/application/scheduling/**`
- `vq/config/worktree-policy.json`
- `.gitignore`
- `dist/**`

## Veiksmas
- Coder: registruoti maršrutą greta esamų `/api/runtime/...` mutacijų tuo pačiu `withJsonBody` šablonu; nevalidus kūnas → 400, sėkmė → `{ enabled, gitignore_ok }`.
- Coder: `router-adapters.ts` — fs adapteriai politikos skaitymui/rašymui, `.gitignore` skaitymui/append ir log eilutei; keliai skaičiuojami iš runtimeRoot/projectRoot, niekada iš request'o.
- Reviewer: patikrinti sluoksnių kryptį (interfaces neimportuoja infrastructure) ir kad failai lieka ≤500 eilučių.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei endpoint'ui prireiktų priimti kelią ar kitą lauką iš request'o.

## Neįtraukta
UI jungiklis (kitas darbas). Politikos VARTOJIMAS scheduling sluoksnyje nekeičiamas.
