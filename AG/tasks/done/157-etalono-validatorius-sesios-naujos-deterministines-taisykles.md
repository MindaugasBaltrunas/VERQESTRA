# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 156-etalono-validatorius-vienas-preflight-taisykles-i-domain

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/tasks/etalonas-rules.ts` turi rule id `priklausomybe-not-a-task-id`,
`failai-prose-inside-leidziama`, `failai-path-both-allowed-and-forbidden`, `neitraukta-empty`,
`cache-version-without-pin-tests`, `agentai-readme-guard-not-first` ir
`src/tests/domain-tasks-etalonas-rules.test.ts` turi korpuso testą per `AG/tasks/queue` ir
`AG/tasks/human-review` — ALREADY_IMPLEMENTED: cituok rule id sąrašą ir korpuso testo pavadinimą.

## Tikslas
Auditas `docs/audits/etalonas-tests-audit-2026-09-03.md` R2–R4: per dvi paras (09-02/03) trys
task'ai parkavosi ar užblokavo bangą dėl etalono taisyklių, kurių nė vienas validatorius netikrina:
(1) prozinė `## Priklausomybės` eilutė (`- 137 pirmoji dalis: …`) — `TASK_ID_SHAPE` nepataiko →
„left alone" → planuoklė `missing-dependency` → `LOOP STOP: all-blocked` 09:51, 16 tokių eilučių
`orchestrator.log`; (2) `> …` anotacija su backtick'ais TARP `Leidžiama:` ir `Draudžiama:` —
kanoninis `allowed-paths.ts:92-98` ją paverčia „keliais" (101-b-03: 8 tikri + 3 iš prozos = 11 > 8,
parkas 12:27); (3) tas pats kelias `Leidžiama` ir `Draudžiama` (101-b-03 turėjo); (4)
`CONTEXT_CACHE_VERSION` kėlimas be dviejų pinančių testų sąraše (138 parkas 09-02). Kiekviena
taisyklė deterministinė ir pigi; fastpath'as „task already canonical" LLM praleidžia, tad šios
taisyklės yra vienintelis vartas.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/etalonas-rules.ts`
- `src/tests/domain-tasks-etalonas-rules.test.ts`
- `AG/tasks/examples/000-etalonas.md` (tik komentaro papildymas, kad taisyklės (a)–(f) įvardytos kaip VYKDOMOS; antraštės nekinta — `task-etalonas-sync.test.ts` jas pina)

Draudžiama:
- `src/domain/tasks/allowed-paths.ts` (importuojami `allowedPaths`/`forbiddenPaths`, nekeičiami)
- `src/domain/tasks/sections.ts`
- `src/interfaces/hooks/pre-hooks.ts`
- `src/application/quality-gates/preflight-fastpath.ts`
- `src/tests/task-etalonas-sync.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- (a) `## Priklausomybės` bullet'as, kuris nėra placeholder ir nėra `knownTaskIds` narys —
  pažeidimas `priklausomybe-not-a-task-id` (etalonas: „arba tikras id, arba sekcijos nėra");
  išimtis tik `<…>` šablonui (pats etalonas). Kai `knownTaskIds === undefined` (156 kontraktas) —
  tikrinama tik id FORMA (`TASK_ID_SHAPE`), ne rezoliucija.
- (b) Ne-bullet eilutė su backtick'ais tarp `Leidžiama:` ir `Draudžiama:` —
  `failai-prose-inside-leidziama`, žinutė nurodo dėti anotaciją VIRŠ `Leidžiama:`.
  (c) `allowedPaths ∩ forbiddenPaths ≠ ∅` — `failai-path-both-allowed-and-forbidden`.
- (d) `## Neįtraukta` tuščias kūnas — `neitraukta-empty`. (f) `## Agentai` pirmos ne tuščios
  eilutės pirmas agentas ne `readme-guard` — `agentai-readme-guard-not-first` (label'is iki
  dvitaškio toleruojamas, kaip `extractChainFromAgentaiSection`).
- (e) `CONTEXT_CACHE_VERSION` paminėtas `## Veiksmas` kūne, o `Leidžiama:` neturi
  `src/tests/context-pack-guards.test.ts` IR `src/tests/context-pack-code-index-identity.test.ts`
  — `cache-version-without-pin-tests` (etalono Failai (9)).
- Testai: kiekvienai taisyklei blokavimo ir praėjimo atvejis; etalonas ir `VALID_TASK` grąžina `[]`;
  KORPUSO testas: visi `AG/tasks/queue/*.md` ir `AG/tasks/human-review/*.md` grąžina `[]` su
  `knownTaskIds` = visų bucket'ų failų stem'ai (tuščia eilė — teisėta). `done` korpusas
  NEtikrinamas: 300 istorinių task'ų rašyti iki taisyklių.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei korpuso testas rastų pažeidimą gyvame
queue/human-review task'e — task'o tekstą taiso operatorius, ne šis task'as. Stop, jei (e)
taisyklei reikėtų skaityti ką nors už task'o teksto (pvz. ar kėlimas realiai vyksta) — taisyklė
lieka tekstinė arba jos nėra.

## Neįtraukta
- Kelių egzistavimo patikra (FS) — preflight CLI pusėje, ne domain'e; atskiras task'as su
  „numatomas naujas" išlyga.
- Etalono `> N.` punktų inventoriaus sync testas (`task-etalonas-sync.test.ts`).
- `HUMAN-REVIEW-APPROVED` vietos („tuoj po `# Task`") tikrinimas — `gates.ts:45` regex šiandien
  priima bet kur; spec/kodo nesutapimas be parkų.
