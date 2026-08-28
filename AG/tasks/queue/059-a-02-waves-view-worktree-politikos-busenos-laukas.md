# Task

## Spec source
`openspec/changes/verqestra-backlog-v1/`

## Tikslas
Workerių lease lentelė `#/system` puslapyje tuščia VISADA, kol worktree politika išjungta, bet UI to įvardyti negali — serveris tos būsenos negrąžina. Pridėti į waves view atsakymą vieną lauką su worktree politikos būsena (įjungta/išjungta ir konfigūracijos kelias `vq/config/worktree-policy.json`), kad UI galėtų parodyti tuščios lentelės PRIEŽASTĮ vietoj „lease'ų nėra".

## Agentai
Privaloma grandinė: `readme-guard -> architect -> coder -> reviewer -> tester`.

## Failai
Leidžiama:
- `src/interfaces/http/ui-waves-view.ts`
- `src/tests/interfaces-http-waves-view.test.ts`

Draudžiama:
- `src/application/**`
- `src/domain/**`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: kur waves view jau mato politikos būseną ir kaip ją išreikšti vienu opcionaliu lauku nelaužant esamo kontrakto.
- Coder: pridėti lauką laikantis `exactOptionalPropertyTypes` (opcionalus laukas per sąlyginį spread'ą); jokio naujo importo iš `infrastructure`.
- Tester: testas dengia abi būsenas — politika įjungta ir išjungta.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei politikos būsena nepasiekiama be naujo porto ar `application` sluoksnio pakeitimo.

## Neįtraukta
UI pusė (WavesPanel/RuntimePanel tuščių būsenų tekstai) — kita užduotis.
