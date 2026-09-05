# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 165-runtime-oversize-skelimas-nekaskaduoja-vaiku-po-done

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/infrastructure-resume-checkpoint.test.ts` nebeturi `assert.ok(true)` (118 eil.),
`scheduling-safe-telemetry.test.ts:27-33` turi asercijas, `infrastructure-work-evidence.test.ts:151,190`
vietoje tylaus `return` naudoja `t.skip` su priežastimi, o `helpers/fake-task-run-ports.ts:128`
fingerprint'as nėra `fp:<length>` — ALREADY_IMPLEMENTED: cituok kiekvieną vietą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, „Testai" P2; `scratchpad/audit-tests.md`
§1-§4): `infrastructure-resume-checkpoint.test.ts:118` vienintelė asercija `assert.ok(true)` („rašymo
klaida nekyla" — netikrina nei kad checkpoint'as neįrašytas, nei kad klaida užfiksuota);
`scheduling-safe-telemetry.test.ts:27-33` be asercijų (neatskiria „nutylėjo" nuo „niekada nekvietė"),
`:101-115` tekstinis vartas `code.includes("deps.log")` vienam failui (`const { log } = deps` apeina);
`infrastructure-work-evidence.test.ts:151,190` `if (head.code !== 0) return;` ne-git aplinkoje praeina
nieko netikrinęs, `:100-199` realus repo git'as kaip fixture (`0123456789abcdef…` „neegzistuoja" tik kol
niekas tokio objekto neturi); `quality-gates-preflight.test.ts:147-180` skaito realų `vq/config/*`
(lokaliai perkalibruotas konfigas daro `pnpm test` raudoną tik toje mašinoje — 146 eil. tai pripažįsta);
korpuso vartai `domain-tasks-etalonas-rules:321-344` ir `markdown-readers-real-corpus:26,60,76` su
`catch(() => [])` be `length > 0` sargo — praeina vakuume; `helpers/fake-task-run-ports.ts:128`
`fingerprint: fp:<length>` vs `coordinator-adapters.ts:128 sha256Hex(bytes)` — dvi to paties ilgio task
versijos fake'e „nepakitusios".

## Agentai
readme-guard -> tester -> reviewer

## Failai
Leidžiama:
- `src/tests/infrastructure-resume-checkpoint.test.ts` (118 eil.)
- `src/tests/scheduling-safe-telemetry.test.ts` (27-33, 101-115 eil.)
- `src/tests/infrastructure-work-evidence.test.ts` (100-199 eil.)
- `src/tests/domain-tasks-etalonas-rules.test.ts` (321-344 eil.)
- `src/tests/markdown-readers-real-corpus.test.ts` (26, 60, 76 eil.)
- `src/tests/helpers/fake-task-run-ports.ts` (128 eil.)

Draudžiama:
- `src/infrastructure/**`, `src/application/**`, `src/domain/**` (tik testai; rasta klaida → ataskaita)
- `src/tests/interfaces-hooks-pre-hooks.test.ts` (korpuso vartas — task 238)
- `src/tests/quality-gates-preflight.test.ts` (task'ai 183, 195, 219 jį liečia lygiagrečiai — realaus `vq/config` atsiejimas atidėtas, žr. Neįtraukta)
- `vq/**` (runtime — testai nuo jo ATSIEJAMI, ne jį keičia)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `resume-checkpoint:118`: `assert.doesNotReject` + būsenos patikra (checkpoint'o failo nėra / klaida
  užfiksuota per `logError` fake'ą); `safe-telemetry:27-33`: kiekvienas `await` gauna asercijas apie
  fake'o iškvietimų sąrašą; `:101-115` tekstinis vartas keičiamas elgesio testu (fake `deps.log` meta →
  scheduler'is nekrenta) arba bent `deps["log"]`/destrukturavimo formomis.
- `work-evidence`: tylų `return` keisti `t.skip("git nepasiekiamas: …")`; realų `process.cwd()` repo
  keisti `mkdtemp` git repo su vienu commit'u (`user.name`, `commit.gpgsign=false`, `core.autocrlf=false`
  — kaip 11 kitų git testų) — „neegzistuojantis" SHA tada tikrai neegzistuoja.
- Korpuso sargai: `domain-tasks-etalonas-rules` — `assert.ok(stems.length > 0)` bent `done` bucket'ui;
  `markdown-readers-real-corpus` — kiekvienai šakniai (`docs`, `.claude`, `templates`) atskiras
  `length > 0`, ne bendras `>= 10`.
- `fake-task-run-ports:128`: `fingerprint` iš `sha256Hex(bytes)` (importuoti tą patį helper'į, kurį
  naudoja `coordinator-adapters.ts:128`); PASKUTINIS žingsnis — jei bet kuris `createFakeTaskRunEnv`
  vartotojas (×48) dėl to raudonas ir gyvena už `## Failai` ribų, ŠĮ vieną pakeitimą atšaukti, o
  radinį (kuris testas rėmėsi ilgio lygybe) įrašyti į ataskaitą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Jei `work-evidence` tmp git repo Windows'e nepavyksta sukurti (teisės,
`safe.directory`) — `t.skip` su priežastimi, ne `return`; tylus praėjimas yra būtent tai, ką šis task'as
šalina.

## Neįtraukta
- `interfaces-cli-preflight*.test.ts:145` `exists: async () => true`, `context-pack.test.ts:54` ENOENT be
  `code`, `infrastructure-dispatch-flow:33`/`interfaces-cli-dispatch-command:30` `process.env` top-level,
  `composition-loop-command:129` laikrodis, `worktree-runtime-bootstrap:118` mtime, `orphan-reaper:72`
  polling, `discovered-docs` fiksuotas tmpdir — §3 likučiai, antra partija.
- `quality-gates-preflight.test.ts:147-180` realus `vq/config/*` (→ `mkdtemp` su `templates/vq/config/*.json`
  kopija) — failą lygiagrečiai keičia 183, 195 ir 219; taisoma atskiru task'u, kai jie bus `done`.
- `pre-hooks:427` realus `vq/` — task 238; vartų sargai (`gate-*`, CSS, i18n) — task 236.
