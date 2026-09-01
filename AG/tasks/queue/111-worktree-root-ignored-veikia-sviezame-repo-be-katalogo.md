# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/infrastructure/git/worktrees/worktree-layout.ts` `worktreeRootIsIgnored`
(dabar 85-88 eil.) prieš `check-ignore` užtikrina šaknies katalogo egzistavimą
ARBA probe'ina vaikinį kelią (pvz. `.ag/worktrees/__probe__`), ir
`src/tests/infrastructure-worktrees.test.ts` turi testą „repo be `.ag/`
katalogo su `.gitignore` eilute → `true`" — ALREADY_IMPLEMENTED: cituok
funkcijos kūną ir testo assert'ą kaip įrodymą.

## Tikslas
W1/w2 slot'ų audito P1 (2026-09-01): šviežiame repo w2 NIEKADA nepasileidžia
be rankinio įsikišimo — vištos-kiaušinio ciklas. Patikrinta:
`worktree-layout.ts:86` probe'ina `WORKTREE_ROOT_DIR = ".ag/worktrees"` BE
galinio pasvirojo per `filterGitIgnored` (`git-client.ts:55-68`,
`git check-ignore --stdin`); `.gitignore` eilutė `.ag/worktrees/`
(directory-only šablonas) NEEGZISTUOJANČIAM keliui nesuveikia — git šabloną su
`/` gale taiko tik katalogams, o kelio, kurio nėra diske, katalogu nelaiko.
Pasekmių grandinė: `wave-provisioning.ts:185-188` gauna `false` ir atsisako
kurti worktree („SLOT PROVISION SKIP: worktree šaknis nėra gitignore'inta"),
o šaknies katalogo niekas niekada nesukuria — jį kuria tik pats worktree
provisioning'as, kuris iki jo neprieina. Šiandien apeita rankiniu `.gitkeep`.
Sprendimo kryptys (vykdytojas pasirenka ir pagrindžia ataskaitoje):
(a) prieš patikrą užtikrinti šaknies katalogą (mkdir -p per fs adapterį —
funkcija gyvena infrastructure, jai galima); (b) probe'ą daryti vaikiniu
keliu (`.ag/worktrees/__probe__`), kuriam dir-only šablonas suveikia ir be
katalogo diske. (b) pranašumas: jokio šalutinio efekto skaitymo kelyje —
`worktreeRootIsIgnored` kviečia ir `preserved-work.ts:105` bei
`worktree-provision.ts:94`, kuriems tylus mkdir būtų netikėtas.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-layout.ts`
- `src/tests/infrastructure-worktrees.test.ts`

Draudžiama:
- `src/infrastructure/git/git-client.ts` (`filterGitIgnored` semantika
  teisinga — problema probe kelio formoje)
- `src/application/scheduling/wave-provisioning.ts` (skaitytojas teisingai
  pasitiki funkcija)
- `src/infrastructure/git/preserved-work.ts` ir
  `src/infrastructure/git/worktrees/worktree-provision.ts` (kvietėjai —
  kontraktas jiems tik pagerėja, kodo keisti nereikia)
- `.gitignore`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `worktree-layout.ts` (`worktreeRootIsIgnored`): įgyvendinti pasirinktą
  kryptį taip, kad funkcija grąžintų `true` šviežiame repo, kuriame
  `.gitignore` turi `.ag/worktrees/` eilutę, bet katalogo diske dar nėra;
  doc-komentaras (84 eil.) papildomas vištos-kiaušinio paaiškinimu.
- Testų lūkestis (`infrastructure-worktrees.test.ts`, realus git tmp repo —
  failo esamas stilius): (1) regresija — repo be `.ag/` katalogo su
  `.gitignore` eilute `.ag/worktrees/` → `true`; (2) repo be eilutės →
  `false` (esamas elgesys nelūžta); (3) repo su katalogu ir eilute → `true`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei pasirinkta kryptis
pareikalautų keisti `filterGitIgnored` signatūrą (git-client yra bendras
secret-scan ir worktree kelias — jo kontrakto keitimas liestų svetimus
vartotojus).

## Neįtraukta
- UI skaitytojų suvienodinimas su `worktreeRootIsIgnored` — task 112
  (priklauso nuo šio kontrakto pataisymo).
- Rankinio `.gitkeep` apėjimo valymas repo — operatoriaus veiksmas, ne kodo.
- `wave-provisioning.ts` SKIP žinučių turtinimas — task 116.
