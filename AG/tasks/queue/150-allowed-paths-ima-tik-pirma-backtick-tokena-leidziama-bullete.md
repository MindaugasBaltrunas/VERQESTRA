# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/tasks/allowed-paths.ts` `collectPathTokensFromLine` bullet
eilutėje (`- ` prefiksas) ima TIK pirmą backtick tokeną, o likusius
backtick'us toje eilutėje laiko pagrindimo tekstu, ir
`src/tests/domain-tasks.test.ts` turi atvejį su antru backtick tokenu
pagrindime — ALREADY_IMPLEMENTED: cituok funkciją ir testą.

## Tikslas
Įrodymas (GeoGravity `vq/logs/orchestrator.log` 2026-09-01 21:29:43):
`WORKER POOL: mode=sequential requested=2 granted=1/2
rejected=1248_module_viewer_snapshot_path_traversal: unknown-scope —
unresolvable-scope: allowed-paths: Scope lock scope must not traverse
upwards: '..'`. Task'o `## Failai / Leidžiama:` eilutė buvo
`- \`modules/viewer-3d-module/tests/\` — \`..\` traversal + projectId regresijos`.
`allowed-paths.ts:86-91` iš eilutės surenka VISUS backtick tokenus
(`line.matchAll(/\`([^\`]+)\`/g)`), tad pagrindimo `..` tapo „keliu",
`conflict-detector.ts:236-248` `classifyWriteScopePath` metė
`ScopeLockError`, planuoklė task'ą nuvarė į sequential režimą pirminiame
medyje (antras slot'as tuščias). Ta pati klasė GeoGravity queue 1255–1284:
`- \`apps/mobile/…/severity.ts\` — naujas: \`DeviationSeverity\` union +
\`severityColor\``, `- \`apps/mobile/tests/app/providers/\` — kiekvienas
\`use*Service\` hook'as` (glob su `*` → `wildcard-scope` spraga),
`- \`.gitignore\` — pridėti \`!.env.example\` po \`.env.*\`` (`.env.*` kaip
leidžiamas kelias!). Etalonas (`AG/tasks/examples/000-etalonas.md`) reikalauja
pagrindimo teksto toje pačioje eilutėje po kelio, o pagrindimas su kodo
identifikatoriais natūraliai turi backtick'us — parseris kovoja su etalonu.

Sprendimo kryptis: bullet eilutėje (`^\s*[-*+]\s`) kelias yra PIRMAS backtick
tokenas; visi tolesni backtick'ai — pagrindimas. Ne-bullet eilutės (inline
`Leidžiama: src/a.ts, src/b/**` forma, kelių backtick tokenų sąrašas vienoje
eilutėje be bullet'o) lieka kaip dabar — `domain-tasks.test.ts:107-121`
kontraktas nesikeičia. Tas pats `collectPathTokensFromLine` naudojamas ir
`Draudžiama:` blokui — taisyklė galioja abiem.

Atmesta alternatyva: filtruoti tokenus pagal „ar panašu į kelią" (turi `/`
arba plėtinį) — `Dockerfile`, `Makefile` yra tikros ribos be `/` ir plėtinio
(parserio komentaras 104 eil.), o `DeviationSeverity.ts` atrodytų kaip
kelias. Pozicija eilutėje yra vienintelis vienareikšmis požymis.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/allowed-paths.ts` (collectPathTokensFromLine: bullet → pirmas backtick tokenas)
- `src/tests/domain-tasks.test.ts` (antras backtick tokenas pagrindime ignoruojamas; inline forma nepakitusi)
- `src/tests/scheduling-conflict-detector.test.ts` (task tekstas su dot-dot pagrindime nebeduoda unresolvable-scope spragos)

Draudžiama:
- `src/application/scheduling/conflict-detector.ts` (klasifikacija teisinga — klaida įvestyje)
- `src/domain/scheduling/scope-lock-rules.ts` (normalizeScopeValue atmetimas lieka)
- `src/domain/tasks/etalonas-rules.ts` (etalono taisyklės nekinta)
- `src/application/quality-gates/preflight-rules.ts` (backtickBareBullets normalizacija nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `allowed-paths.ts` `collectPathTokensFromLine`: jei eilutė yra bullet
  (`^\s*[-*+]\s+`), iš `backticked` imti tik `[0]`; kitaip — esama logika.
  Bare tokenų (be backtick'ų) kelias nekinta.
- Atnaujinti funkcijos komentarą (82-85 eil.), kad taisyklė būtų matoma iš
  kodo, ne tik iš testo.
- Testų lūkestis (`domain-tasks.test.ts`): (1)
  `- \`src/a/\` — \`..\` traversal regresijos` → `["src/a/"]`; (2)
  `- \`src/ui/x.ts\` — naujas: \`Foo\` + \`bar\`` → `["src/ui/x.ts"]`; (3)
  `Draudžiama:` bullet su antru backtick'u → tik pirmas; (4) inline
  `Leidžiama: src/a.ts, src/b/**` ir bullet be backtick'ų — nepakitę; (5)
  `- \`a.ts\`, \`b.ts\`` (du keliai viename bullet'e) → tik `a.ts` —
  DOKUMENTUOTAS sąmoningas pokytis: etalonas reikalauja vieno kelio bullet'ui.
- `scheduling-conflict-detector.test.ts`: task tekstas su dot-dot pagrindime
  → `gaps` be `unresolvable-scope`, scope tik iš pirmo tokeno.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `grep` per
`AG/tasks/queue` ir `AG/tasks/done` VERQESTRA repo randa bullet'ą su DVIEM
keliais viename backtick sąraše, kurio antras kelias realiai naudojamas
(pvz. task'as rašo į abu) — tada (5) atvejis lūžtų realiam task'ui ir
reikia operatoriaus sprendimo dėl tų task'ų perrašymo.

## Neįtraukta
- GeoGravity queue 1255–1284 eilučių perrašymas — nebereikalingas po šio
  task'o; jei operatorius nori, tai daroma GeoGravity pusėje.
- Etalono (`000-etalonas.md`) papildymas pastaba apie backtick'us
  pagrindime — po šio task'o pastaba nebūtina; jei norima, `documenter`
  atskirai.
- `size.ts:132` `isPathShapedToken` filtras — jis lieka kaip antras sargas
  dydžio skaičiavimui, čia neliečiamas.
