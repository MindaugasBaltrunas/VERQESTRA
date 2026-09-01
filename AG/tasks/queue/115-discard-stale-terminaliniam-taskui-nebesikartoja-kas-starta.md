# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/resume-run.ts` `decideResume` terminalinei
vietai (`location === "terminal-bucket"`) nebegrąžina `discard-stale` esant
graph-hash nesutapimui (taisyklių tvarka sukeista terminalinei vietai) ARBA
`src/application/scheduling/wave-scheduler.ts` `discard-stale` šaka turi
checkpoint'o uždarymo kelią terminaliniam task'ui — ALREADY_IMPLEMENTED:
cituok taisyklės/uždarymo kodą ir testą kaip įrodymą.

## Tikslas
W1/w2 slot'ų audito P3 (2026-09-01): terminaliniam (`done`) task'ui
`discard-stale` kartojasi KIEKVIENAME starte iki pirmo sėkmingo dispatch'o —
operatoriaus log'e 095-b-03 gavo `discard-stale` ×5. Mechanizmas patikrintas:
`resume-run.ts` `decideResume` taisyklių tvarka (149-154 eil.) —
graph-hash-mismatch (4 taisyklė, 149-151) tikrinama PRIEŠ terminal-bucket
(5 taisyklė, 153-155), tad net `done` bucket'e gulintis task'as su senu
`graph_hash` checkpoint'e gauna `discard-stale`, o ne `skip-completed`;
`wave-scheduler.ts` (356-401 eil.) uždarymo kelią turi TIK `skip-completed`
šaka (362-386, su `closeSkipCompletedTaskFile` ir `state.completed`), o
`discard-stale` — tik bendrą log'ą (388-398); checkpoint'as
(`vq/state/claude-resume.json`, skaitomas per
`composition/loop/command.ts:174-185` → `readResumeCheckpoint`) lieka su
senu graph_hash ir kitą startą viskas kartojasi. Sprendimo kryptys
(vykdytojas pasirenka ir pagrindžia): (a) `decideResume` — terminalinei
vietai `terminal-bucket` taisyklė taikoma PRIEŠ graph-hash palyginimą
(task'as, gulintis done, yra užvertas nepriklausomai nuo to, kuriam grafui
priklausė checkpoint'as; `skip-completed` šaka tada uždaro natūraliai);
(b) `wave-scheduler.ts` — `discard-stale` + terminal-bucket atvejui
išvalyti/perrašyti checkpoint'ą. (a) pranašumas: sprendimas lieka vienoje
grynojoje funkcijoje su aiškia taisyklių tvarka (117-131 eil. doc'as —
„tvarka yra pati taisyklė", tad jos keitimas dokumentuojamas ten pat).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/resume-run.ts`
- `src/application/scheduling/wave-scheduler.ts` (tik jei pasirenkama (b)
  išvalymo šaka arba (a) atveju reikia log/event patikslinimo)
- `src/application/scheduling/wave-scheduler-contract.ts` (tik (b): clear
  porto pridėjimas)
- `src/composition/loop/command.ts` (tik (b): porto surišimas)
- `src/infrastructure/state/resume-checkpoint.ts` (tik (b): išvalymo
  funkcija)
- `src/tests/scheduling-waves.test.ts` (decideResume taisyklių testai)
- `src/tests/scheduling-wave-scheduler.test.ts`

Draudžiama:
- `WAVE-2` semantikos keitimas: priimtas commit (145-147 eil.) ir
  `already-completed` (141-143 eil.) taisyklės lieka aukščiau visko
- `src/application/scheduling/wave-provisioning.ts` (113/114/116 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Įgyvendinti pasirinktą kryptį; (a) atveju: `decideResume` terminal-bucket
  patikra perkeliama prieš graph-hash taisyklę, doc-komentaro taisyklių
  sąrašas (117-131 eil.) atnaujinamas, reason kodas atspindi tiesą (pvz.
  `terminal-bucket` vietoje `graph-hash-mismatch`).
- `describeStrandedStaleResume` (182-185 eil.) elgesys resumable vietai
  NEKINTA — stranded įspėjimas saugo kitą, tebegyvą klasę.
- Testų lūkestis: (1) regresija — checkpoint'as su senu graph_hash + task'as
  terminaliniame bucket'e → `skip-completed` (ne `discard-stale`), o
  scheduler'io lygyje antras startas to paties nebekartoja; (2) checkpoint'as
  su senu graph_hash + task'as resumable/queue vietoje → `discard-stale`
  LIEKA (stale grafo apsauga nesusilpninta); (3) esami decideResume tvarkos
  testai atnaujinami pagal naują dokumentuotą tvarką.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad
`skip-completed` uždarymo kelias (`closeSkipCompletedTaskFile`) terminaliniam
task'ui su svetimu graph_hash turi šalutinį efektą, kurio (a) kryptis
nenumatė (pvz. bandymas perkelti jau done failą) — tada rinktis (b) arba
derinti abi.

## Neįtraukta
- `discard-stale` resumable vietai automatinis requeue — atskira problema,
  užfiksuota `describeStrandedStaleResume` komentare (GeoGravity 1178-a-02).
- Checkpoint'o rašymo pusės (`recordResumeCheckpoint`) semantika — rašytojas
  teisingas, problema skaitymo sprendime.
