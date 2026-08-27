# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Po LLM reformulacijos patikrinti reformuluoto task'o `## Failai` kelius ankstesne užduotimi pridėta taisykle. Radus įrodytai klaidingą kelią (tėvinio katalogo nėra), reformuluoto task'o `## Failai` sekcija PAKEIČIAMA ORIGINALAUS task'o sekcija ir įrašoma garsi `CLAUDE PREFLIGHT: ... hallucinated-allowed-path` log eilutė.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/preflight-llm.ts`
- `src/interfaces/cli/dispatch/claude-preflight/preflight-ports.ts`
- `src/tests/interfaces-cli-preflight.test.ts`

Draudžiama:
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts`
- `src/interfaces/hooks/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Katalogo egzistavimo predikatą imk iš esamų preflight portų (`PreflightFilePorts`); jei reikia, pridėk vieną siaurą metodą prie porto — jokio tiesioginio `node:fs` čia.
- Pakeisk TIK `## Failai` sekciją originalo tekstu; jei originalas turėjo konkrečius kelius, wildcard'as neįrašomas.
- Fail-open: nieko nekeisk, kai klaidingų kelių nerasta arba kelias yra glob'as.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei originalo `## Failai` perėmimas imtų reikšti wildcard'o įrašymą ten, kur originalas turėjo konkrečius kelius.

## Neįtraukta
- Task skaidymo pusė (`task-splitting.ts`) — atskira užduotis.
- Scope guard'o / rollback elgesys.
