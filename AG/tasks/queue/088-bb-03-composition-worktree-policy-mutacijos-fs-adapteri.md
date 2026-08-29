# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Surišti `POST /api/runtime/worktree-policy` maršrutą su tikrais fs adapteriais: politikos failo skaitymas/rašymas, `.gitignore` skaitymas ir append, log eilutė. Visi keliai skaičiuojami iš runtimeRoot/projectRoot.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/ui/router-adapters.ts`
- `src/tests/composition-worktree-policy-wiring.test.ts`

Draudžiama:
- `src/interfaces/http/ui-worktree-policy.ts`
- `src/interfaces/http/ui-router-mutations.ts`
- `src/interfaces/http/ui-waves-view.ts`
- `src/application/scheduling/**`
- `vq/config/worktree-policy.json`
- `.gitignore`
- `dist/**`

## Veiksmas
- Coder: `router-adapters.ts` — sukurti `WorktreePolicyPorts` implementaciją (politikos read/write, `.gitignore` read/append, log eilutė) ir perduoti ją į router deps; keliai skaičiuojami iš runtimeRoot/projectRoot, niekada iš request'o.
- Coder: rašymas turi būti idempotentiškas — pakartotinis tas pats `enabled` nedubliuoja `.gitignore` eilutės.
- Tester: teste naudoti laikiną katalogą (jokio realaus repo `.gitignore` ar `vq/config` lietimo) ir padengti abu `enabled` kelius.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei surišimui prireiktų keisti interfaces porto kontraktą arba rašyti į repo šakninį `.gitignore` testo metu.

## Neįtraukta
UI jungiklis. Politikos VARTOJIMAS scheduling sluoksnyje nekeičiamas.
