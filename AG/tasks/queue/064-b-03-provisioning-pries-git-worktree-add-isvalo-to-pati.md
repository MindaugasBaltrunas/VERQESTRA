# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Pašalinti kolizijos sufikso priežastį. `inspectTaskWorktree` (`worktree-provision.ts:42-45`) negyvą registraciją (katalogo nebėra) siunčia į karantiną su `prunable`, o užrakintos registracijos `git worktree prune` nebešalina — todėl nauja registracija gauna `-a12` tipo sufiksą ir kaupiasi liekanos. Negyva registracija turi būti IŠVALYTA, ne užrakinta.

## Agentai
Privaloma grandinė (šia tvarka, be praleidimų): `readme-guard -> architect -> coder -> reviewer -> tester`.

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-provision.ts`
- `src/tests/infrastructure-worktrees.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-registration-cleanup.ts`
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts`
- `src/application/**`
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Veiksmas
- `createTaskWorktree` prieš `git worktree add` kviečia registracijų valymą iš `worktree-registration-cleanup.ts`, kai to paties vardo registracija yra negyva (katalogo nebėra).
- `prunable` kelias nebeveda į karantiną: išvalyta registracija leidžia švarų `absent` startą. Visos KITOS karantino priežastys (nešvarus medis, svetima šaka, kitas lease) lieka nepaliestos — automatinis `remove --force` čia ir toliau negalimas.
- Testas `infrastructure-worktrees.test.ts` įrodo: negyva registracija prieš `add` išvaloma ir nauja kopija gauna vardą be kolizijos sufikso; gyva nešvari kopija vis dar keliauja į karantiną.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok ir klausk, jei pakeitimas reikalautų susilpninti karantino invariantą arba keisti `CreateWorktreeResult` kontraktą.

## Neįtraukta
Gyvų lock'ų arbitražas tarp lygiagrečių vaiko git komandų. Preserved ref'ų valymas (063 scope).
