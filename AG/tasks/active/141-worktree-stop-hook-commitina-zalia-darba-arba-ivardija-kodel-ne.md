# Task

HUMAN-REVIEW-APPROVED: operatorius 2026-09-02 „aš visus tasks approve" (raktažodžių vartai)

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 126-terminalinis-perejimas-isvalo-current-task-file-zyme

## Žingsnis 0 — ar jau įgyvendinta?
Jei worktree Stop hook'o kelias (`src/interfaces/hooks/on-stop.ts` +
`on-stop-context.ts` staging scope) turi diagnozuotą ir uždarytą priežastį,
kodėl 098 klasės bėgime commit'as neįvyko (testas su atkurta sąlyga →
commit'as vyksta arba priežastis garsiai įvardijama), IR verify-task
žinutė skiria „commit missing (executor wrote files)" nuo „work missing" —
ALREADY_IMPLEMENTED: cituok diagnozės išvadą kode/teste ir žinučių skirtį
kaip įrodymą.

## Tikslas
Vakaro parkavimo P1 šaknis (098, 2026-09-01 18:28): patikros žalios,
diagnozė `verdict=done` („checks passed and changed files are inside
allowed paths"), bet po 19 s `WAVE SLOT CHILD EXIT 1` — verify-task
re-check atmetė, nes COMMIT'O NĖRA. Log įrodymai: (1) worktree kopijos
hooks.log rodo worker'io TIESIOGINĮ `git commit` bandymą, užblokuotą
`not-allowlisted:git` — tai TEISINGAS blokas (bash politika vykdytojui git
draudžia, commit'as priklauso Stop hook'ui,
`domain/policies/bash-command-policy.ts:135` operatorinis kanalas); (2) Stop
hook'as worktree 16:10 pravarė skenus (secret/package/migration), bet
„Automatiškai generuota commit žinutė"/„git commit" eilučių NĖRA ir
`vq/logs/commit.log` neegzistuoja — hook'as iki commit žingsnio NEPRIĖJO.
Palyginimui 099/100/097 TAME PAČIAME kelyje praėjo — skirtumo diagnozė yra
šio task'o ESMĖ, NESPĖTI: perskaityti abiejų worktree kopijų hooks.log
PILNAI (kritusio 098 ir praėjusio, pvz. 097) ir palyginti. Tikrintinos
hipotezės (eile): (a) staging scope filtras išmetė 098 failus — 126 klasės
mechanizmas (`on-stop-context.ts:180` skaito `current-task-file`; stalus
žymuo rodo svetimą task'ą → „Produkto pakeitimų nėra" — būtent 126
incidento parašas; todėl priklausomybė nuo 126, kuris valo žymę, bet
worktree kopijos `vq/state` yra ATSKIRAS — vaiko žymės būsena tikrinama
atskirai); (b) session-writes ledger'io būsena worktree kopijoje (ar
hook'as matė vykdytojo rašymus); (c) hook'o staging'as failus rado, bet
commit šaka neįvyko dėl kitos sąlygos. Kryptis PO diagnozės: worktree Stop
hook'o kelias privalo commit'inti vykdytojo darbą arba GARSIAI įvardyti
kodėl ne (tyli tuštuma po žalio darbo — draudžiama), o verify-task/
dispositions žinutė skiria „commit missing" (rašymai buvo, medis purvinas,
commit'o nėra — hook problema) nuo „work missing" (rašymų nebuvo).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/hooks/on-stop.ts`
- `src/interfaces/hooks/on-stop-context.ts`
- `src/application/task-execution/verify-task.ts` (žinutės skirtis; failas
  deklaruotas ir 126 — todėl priklausomybė)
- `src/domain/diagnosis/dispositions.ts` (TIK
  `resolveNoCommitReviewReason` / priežasčių tekstai — priėmimo logika
  su markerio taisyklėmis NEKEIČIAMA)
- `src/tests/interfaces-hooks-on-stop.test.ts`
- `src/tests/task-execution-run.test.ts`
- `src/tests/characterization-diagnosis.test.ts` ir
  `src/tests/fixtures/characterization/diagnosis-dispositions.json` (tik
  jei keičiasi priežasčių tekstai — characterization fixture seka)

Draudžiama:
- `src/domain/policies/bash-command-policy.ts` (git blokas vykdytojui
  TEISINGAS — jo nesilpninti)
- `resolveNoCommitDisposition` sprendimo šakos (`dispositions.ts:255-292`)
  — markerio/fail-closed logika yra 060/095 pamokos, keičiami tik
  ĮVARDIJIMO tekstai
- `src/infrastructure/state/task-state-store.ts` (126 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- DIAGNOZĖ (pirmas žingsnis, išvados į ataskaitą): pilnas 098 vs 097
  worktree hooks.log palyginimas; nustatyti, kurioje Stop hook'o grandinės
  vietoje 098 kelias išsišakojo nuo praėjusių (staging scope? ledger?
  commit šakos sąlyga?). Jei šaknis pasirodys VIEN 126 valymo klausimas —
  patikrinti, ar 126 mechanizmas dengia ir VAIKO worktree `vq/state`
  žymę (vaiko kopija bootstrap'inama iš tėvo — stalus turinys galėjo
  atkeliauti su kopija), ir uždaryti likutį čia.
- Pagal diagnozę: Stop hook'o kelio pataisa, kad žalias vykdytojo darbas
  worktree būtų commit'inamas, o kiekviena „ne-commit" baigtis paliktų
  GARSIĄ log eilutę su priežastimi (tyli tuštuma draudžiama).
- Žinučių skirtis: „executor made no write-tool calls" lieka; naujas
  atvejis „writes present, tree dirty, no commit — stop hook did not
  commit" gauna SAVO priežastį, kad operatorius nebūtų siunčiamas ieškoti
  dingusio darbo, kai problema hook'e.
- Testų lūkestis: (1) regresija su atkurta 098 sąlyga (pagal diagnozės
  išvadą — pvz. stalus current-task-file vaiko kopijoje + vykdytojo
  rašymai) → commit įvyksta ARBA garsi priežastis log'e ir tiksli
  human-review žinutė; (2) 097 klasės praėjęs kelias nepakitęs; (3) esami
  on-stop ir dispositions testai žali be silpninimo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei diagnozė parodytų, kad
šaknis reikalauja keisti bash politikos git bloką arba worktree bootstrap
kopijavimo aibę (`vq/state` į kopiją) — abu yra platesni kontraktai.

## Neįtraukta
- OPERATORIAUS PASTABA (atgavimas): parkuotoje 098 worktree kopijoje guli
  ŽALIAS neintegruotas darbas — kol kopija neišmesta, jį galima atgauti
  rankiniu būdu ar per preserved kelią; šis task'as praeities kopijos
  negelbsti, tik uždaro klasę ateičiai.
- `current-task-file` valymas TĖVO medyje — 126 (ši priklausomybė).
- Vaiko human-review verdikto propagacija — 135.
- Worktree pnpm aplinka — 134.
