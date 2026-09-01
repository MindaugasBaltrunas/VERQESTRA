# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei worktree kopijoje `pnpm build`/`pnpm test` praeina (worktree bootstrap
sutvarko pnpm aplinką — pvz. `worktree-runtime.ts` rašo kopijos-lokalų
`.npmrc` ar daro install vietoj junction'o) ARBA vartų vykdymo taškas
(`quality-check-runner.ts` / jo kvietėjai) worktree kontekste komandas
verčia į pnpm-free formas — ALREADY_IMPLEMENTED: cituok pasirinktos šakos
kodą ir testą kaip įrodymą.

## Tikslas
Gyvo churn ciklo P0 šaknis #1 (2026-09-01, per valandą 9 parkavimai): vaiko
worktree kopijose `## Patikra` komandos KRENTA dėl aplinkos, ne dėl kodo.
Įrodymai: 6 task'ai (096@09:00, 099@09:27, 103@09:56, 113@09:51, 114@10:22,
115@10:30) parkuoti IDENTIŠKA `CLAUDE DIAGNOSIS verdict=human_review
reason=repeated error signature: clear local issue: exit_code: 1`; task'as
100@09:26 parkuotas `changed files outside allowed paths: .npmrc` — worker'is
PATS bandė taisyti pnpm aplinką. Lygiagrečios sesijos diagnozė
(verqestra-worktree-pnpm-blocked.md): `.ag/worktrees` kopijose pnpm krenta
ERR_PNPM_UNSAFE_MODULES_DIR — `WORKTREE BOOTSTRAP` node_modules aprūpina
JUNCTION'AIS į pirminį medį (`worktree-runtime.ts:165-176` — sąmoningas
dizainas: nulis I/O, read-only invariantas), o pnpm atsisako dirbti su
svetimos virtual-store node_modules struktūra; `npm run lint|build` +
`node --test` ten veikia. Vykdymo taškas patikrintas:
`infrastructure/process/quality-check-runner.ts:27-41` `runQualityCheck` —
VIENA vykdymo forma visiems vartams, cwd ateina iš kvietėjo (vaiko worktree).
Sprendimas — architect ŽINGSNIS tarp: (a) vertimo taškas — worktree
kontekste (cwd po `.ag/worktrees` ar aptiktas junction'intas node_modules)
pnpm komandos deterministiškai verčiamos į npm/node ekvivalentus VIENOJE
vietoje; (b) bootstrap'as sutvarko pnpm aplinką kopijoje (kopijos-lokalus
`.npmrc` su tinkamu virtual-store nustatymu arba lockfile install vietoj
junction'o — kaina: laikas kiekvienam worktree). Kryptis (c) — `## Patikra`
kontrakto praplėtimas worktree-safe formomis — reikalautų etalono ir
`etalonas-rules.ts` keitimo, t. y. operatoriaus sprendimo (žr. Stop).
Etalonas (AG_loop) worktree'ų neturi — tai VERQESTRA sritis, nukrypimo
įrašo nereikia.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-runtime.ts` ((b) šaka —
  bootstrap žingsnis; (a) šakoje neliečiamas)
- `src/infrastructure/process/quality-check-runner.ts` ((a) šaka — vertimo
  taškas; (b) šakoje neliečiamas)
- `src/composition/quality/adapters.ts` ((a) šaka — jei vertimui reikia
  konteksto iš kvietėjo pusės)
- `src/tests/worktree-runtime-bootstrap.test.ts` ((b) šakos testai)
- `src/tests/infrastructure-quality-check-runner.test.ts` ((a) šakos testai)

Draudžiama:
- `src/composition/loop/command.ts` (115 queue task'o scope — jei (b) šakai
  reikėtų `WorktreeRuntimeLayout` configFiles keitimo per šį failą, Stop ir
  priklausomybės klausimas, ne tylus lietimas; bootstrap žingsnis gali
  gyventi worktree-runtime viduje be layout keitimo)
- `AG/tasks/examples/000-etalonas.md` ir `src/domain/tasks/etalonas-rules.ts`
  ((c) kryptis — tik operatoriaus pavedimu)
- `.npmrc` (šakninis — pirminio medžio pnpm elgesys nekeičiamas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- ŽINGSNIS 1 (architect): (a) ar (b) su pagrindimu ataskaitoje. Svarstyti:
  (a) nulis papildomo I/O ir laiko, bet npm/pnpm elgesio skirtumai (lockfile
  nepaisymas, scripts rezoliucija) turi būti įvardinti; (b) pnpm lieka
  vienintelė tiesa, bet kaina — install laikas arba .npmrc suderinamumas su
  junction'ais (patikrinti, ar pnpm su junction'intu node_modules apskritai
  įmanomas per konfigą — jei ne, (b) reiškia junction'ų atsisakymą su
  worktree-runtime.ts:165-176 dizaino peržiūra).
- Įgyvendinti pasirinktą šaką VIENAME taške (jokių kopijų skirtinguose
  vartuose — quality-check-runner antraštės 4-6 eil. taisyklė).
- Testų lūkestis: (a) — worktree kontekste `pnpm build` deterministiškai
  virsta npm/node ekvivalentu, ne-worktree kontekste NIEKAS nesikeičia;
  (b) — bootstrap palieka kopiją, kurioje pnpm komanda neatsitrenkia į
  unsafe-modules-dir (unit lygiu: .npmrc turinys/install žymuo; realaus
  pnpm E2E nereikalaujama).
- ATASKAITOS ŽINGSNIS: CLAUDE.md „Greitas ciklas" sekcijai gali reikėti
  papildymo apie worktree patikras — įrašyti kaip pasiūlymą operatoriui,
  CLAUDE.md nekeisti be pavedimo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei: (1) abi šakos
pasirodytų reikalaujančios `## Patikra` kontrakto keitimo ((c) kryptis —
etalono failas, operatoriaus sprendimas); (2) (b) šakai reikėtų keisti
`composition/loop/command.ts` layout'ą (115 scope sankirta).

## Neįtraukta
- `## Patikra` leistinų formų sąrašo (`ALLOWED_PATIKRA_COMMANDS`) plėtimas —
  tik operatoriaus pavedimu, atskiras task'as.
- Jau parkuotų 9 task'ų grąžinimas — operatoriaus/orchestratoriaus veiksmas;
  worktree verdikto pasiekiamumo defektas — task 135.
- `.npmrc` valymas iš 100 task'o worktree kopijos — kopijos išmetamos.
