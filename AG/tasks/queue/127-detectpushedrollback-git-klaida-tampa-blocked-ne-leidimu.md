# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/infrastructure/git/rollback-scope.ts` `detectPushedRollback` (dabar
29-47 eil.) tikrina `rev-list --count` exit kodus ir nesėkmę paverčia
`blocked: true` su priežastimi — ALREADY_IMPLEMENTED: cituok kodo patikros
šaką ir testą kaip įrodymą.

## Tikslas
Audito P2 (2026-09-01): fail-open ant DESTRUKTYVAUS varto. Patikrinta
`rollback-scope.ts:37-46`: `git rev-list --count` rezultatų exit kodai
NETIKRINAMI — `Number(total.stdout.trim() || "0")` nesėkmės atveju (tuščias
stdout) duoda 0, o šiukšlinis stdout — NaN; abiem atvejais
`pushedRollbackBlock` (`domain/git/rollback-rules.ts`) gauna skaičius, su
kuriais grąžina `blocked: false`. Vartotojas —
`interfaces/cli/bootstrap/rollback-stable.ts` (Grep: kvietimas ~268 eil.) —
tai vartas PRIEŠ push'intos istorijos perrašymą. Realus scenarijus: pasenęs
ar GC nušluotas `stableRef` → `rev-list` grąžina code 128 → vartas LEIDŽIA
perrašyti istoriją, kurios saugumo klausimo net nepamatavo. Kontrastas tame
pačiame faile: `preserveTaskScope`/`restoreTaskScope` keliai jau fail-closed
(klaida → failures sąrašas). Sprendimas: abiejų `rev-list` kvietimų
`code !== 0` → `blocked: true` su detail, įvardijančiu komandą ir priežastį —
nežinia ant destruktyvaus varto yra blokas, ne leidimas.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/rollback-scope.ts`
- `src/tests/infrastructure-git.test.ts` (rollback-scope testai; jei
  detectPushedRollback dengiamas `interfaces-cli-rollback-stable.test.ts` —
  tas failas vietoje šio ar kartu, įrašyti į ataskaitą)
- `src/tests/interfaces-cli-rollback-stable.test.ts` (CLI žinutės apie
  bloką, jei jos assert'inamos)

Draudžiama:
- `src/domain/git/rollback-rules.ts` (`pushedRollbackBlock` gryna taisyklė
  teisinga — jos įėjimų kokybę užtikrina surinkėjas; keisti tik jei
  blocked-with-detail formai reikia tipo lauko, tada įrašyti į ataskaitą su
  pagrindimu)
- `src/interfaces/cli/bootstrap/rollback-stable.ts` (vartotojas nekinta —
  blocked kelias jau apdorojamas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `rollback-scope.ts` (`detectPushedRollback`): po abiejų `rev-list`
  kvietimų tikrinti `code !== 0` → grąžinti blocked sprendimą su detail
  (komanda, exit kodas, stderr santrauka be vidinių kelių); NaN apsauga —
  `Number.isFinite` patikra prieš paduodant į domain taisyklę.
- Ankstesnės trumpinimo šakos (31-36 eil.: nėra HEAD / nėra branch / nėra
  upstream → `blocked:false`) LIEKA — jos yra pagrįsti „nėra ką saugoti"
  atvejai, ne klaidos.
- Testų lūkestis: (1) regresija — `rev-list` code 128 (pvz. neegzistuojantis
  stableRef) → blocked su priežastimi; (2) šiukšlinis stdout → blocked (ne
  NaN leidimas); (3) esami happy-path ir trumpinimo testai žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei blocked formos
praturtinimas pareikalautų keisti `PushedRollbackDecision` tipą taip, kad
lūžtų kiti jo skaitytojai.

## Neįtraukta
- ŽINOMI STEBĖJIMAI iš to paties audito (task'ų nekurta, fiksuojama čia
  kaip artimiausiame git scope): (1) `domain/git/changes.ts:107-116`
  quotePath — ne-ASCII keliai git status parseriuose gali ateiti C-quoted
  forma; (2) `infrastructure/git/integration-branch.ts:111-112`
  `appliedSourceCommits` gali įsiminti transient klaidos rezultatą. Abu —
  įtariami, be reprodukcijos; kandidatai atskiriems task'ams tik su
  įrodymu.
- `rollback-stable` CLI srauto keitimai — vartas tik tampa sąžiningas.
