# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Papildyti waves/system view atsakymą lauku `worktree_gitignore_ok: boolean` šalia esamo `worktree_policy` (059-a), kad UI matytų pilną w2 parengtį. Naujas portas deklaruojamas kaip OPCIONALUS (kaip ir esamas `worktree_policy` yra opcionalus laukas) — composition šiame darbe nekeičiama, todėl build lieka žalias; kai porto nėra, laukas praleidžiamas.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-waves-view.ts`
- `src/tests/interfaces-http-waves-view.test.ts`

Draudžiama:
- `src/composition/ui/router-adapters.ts`
- `src/interfaces/http/ui-router-mutations.ts`
- `src/application/scheduling/**`
- `vq/config/worktree-policy.json`
- `.gitignore`
- `dist/**`

## Veiksmas
- Coder: pridėti opcionalų portą `readWorktreeGitignoreOk(absoluteGitignoreFile): Promise<boolean>` ir lauką `worktree_gitignore_ok` į `worktree_policy` bloką per sąlyginį spread (`exactOptionalPropertyTypes`); klaida skaitant elgiasi kaip esamas `worktree_policy` degradavimo kelias.
- Tester: portas grąžina true → laukas true; false → false; porto nėra → laukas praleistas, o esamas `enabled`/`config_path` elgesys nepakitęs.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei portą tektų daryti privalomą (tai sugriautų composition be wiring).

## Neįtraukta
Composition wiring ir POST endpoint'as (kitas darbas). UI (kitas darbas).
