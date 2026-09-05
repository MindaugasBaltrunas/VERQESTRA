# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/tasks/human-review/evidence.ts` `securityEvidence` (45 eil.) ir
`outboundCommunicationEvidence` (106 eil.) kelio substring'us lygina segmentų ribomis (kelias
`.claude/agents/task-author.md` NEduoda `path:` įrodymo, `src/oracle.ts` NEduoda, `git-push-helper.ts`
NEduoda) IR `src/domain/tasks/human-review/gates.ts` `HUMAN_REVIEW_APPROVED_RE` taikomas per
`markdownFenceMask` (šablono citata trijų backtick'ų fence'e NEsuveikia kaip patvirtinimas) —
ALREADY_IMPLEMENTED: cituok abu regex'us / mask'o kvietimą ir testų pavadinimus.
Jei tik viena pusė padaryta — daryti likusią; ataskaitoje įvardyti, kuri jau buvo.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, D4 ir D7).
D4: `evidence.ts:45` `/auth|security|...|acl|.../.test(file)` ir `:106` `/email|...|sms|push|.../.test(file)`
— kelio substring'ai be ribų. `auth` ⊂ `.claude/agents/task-author.md`, `acl` ⊂ `oracle.ts`, `push` ⊂
`git-push-helper.ts` → `path:` įrodymas → security/outbound vartas → task'as parkuojamas human-review.
VERQESTRA pati turi `task-author` agentą (CLAUDE.md jį daro privalomu), tad kiekvienas task'as, kurio
`## Failai` liečia `.claude/agents/task-author.md`, šiandien parkuojasi. Testas pina tik
`src/auth/token.ts`. Tekstiniai regex'ai (49-51, 68, 76, 93-97, 108 eil.) ribas jau turi — nesuderinta
tik kelio pusė. Kryptis: kelio segmentų/žodžių ribos (`(^|[/._-])auth([/._-]|$)` tipo), kaip
`task-classification.ts` `pathFragmentMatches` — ne sąrašo siaurinimas.
D7 (PLAUSIBLE — pradėti nuo įrodančio testo): `gates.ts:45-48` `HUMAN_REVIEW_APPROVED_RE` su `m`
vėliava taikomas VISAM task tekstui be `markdownFenceMask` (`src/shared/markdown.ts`). Task'as,
cituojantis šabloną fenced bloke (kaip `000-etalonas.md:10`), gautų `approved_marker="<kas> <data>"` →
visi rizikos vartai nutildomi. Visi kiti markdown skaitytojai nuo 2026-08-24 fence-aware; šis — ne.
Jei įrodantis testas žalias (žyma fence'e nesuveikia) — D7 dalis ALREADY_IMPLEMENTED su testu kaip
įrodymu.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/human-review/evidence.ts` (`securityEvidence` 44-46 eil., `outboundCommunicationEvidence` 106 eil.; peržiūrėti ir 63, 79, 88 eil. tuo pačiu principu)
- `src/domain/tasks/human-review/gates.ts` (`HUMAN_REVIEW_APPROVED_RE` 45-48 eil. → `markdownFenceMask`)
- `src/tests/domain-human-review.test.ts`

Draudžiama:
- `src/shared/markdown.ts` (`markdownFenceMask` importuojamas, nekeičiamas)
- `src/application/quality-gates/preflight.ts` (vartotojas per `analyzeHumanReviewGates`, nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `evidence.ts`: įvesti vieną helper'į `pathSegmentMatches(file, fragment)` (žodžio riba = ne `[a-z0-9]`
  simbolis arba kraštas) ir per jį leisti 45, 106 eil. sąrašus; tą patį taikyti 63 (`deploy`), 79
  (`seed|cleanup|...`), 88 (`billing|...`) eil., jei elgesys išlieka etalono testams. Sąrašų turinys
  nesiaurinamas.
- `gates.ts`: prieš `taskText.match(HUMAN_REVIEW_APPROVED_RE)` tekstą praleisti per
  `markdownFenceMask` (kaip daro `extractSection`), kad fenced blokų eilutės žymos neduotų.
- Testai `domain-human-review.test.ts`: (D4) `.claude/agents/task-author.md`, `src/oracle.ts`,
  `git-push-helper.ts` NEduoda `path:` įrodymų; `src/auth/token.ts`, `services/push-notifications.ts`,
  `lib/acl/rules.ts` — duoda. (D7) task'as su trijų backtick'ų `text` fence bloku, kuriame yra
  `HUMAN-REVIEW-APPROVED: <kas> <data>`, ir security keyword'u tekste → `requires_human_review: true`,
  be `approved_marker`; ta pati žyma ne fence'e (su `-` prefiksu ir be) → suveikia kaip iki šiol.
- Korpuso patikra: Grep'u per `AG/tasks/queue/*.md` ir `AG/tasks/done/*.md` surasti task'us, kurių
  `## Failai` keliai šiandien duoda klaidingą `path:` įrodymą (`task-author`, `oracle`, `push`), ir
  įrašyti į ataskaitą — tai įrodymas, kad klasė reali; failų redaguoti nereikia (taisyklė švelnėja).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei ribų taisyklė pakeičia bet kurio esamo
`domain-human-review.test.ts` etalono atvejo (GeoGravity 2026-07, 856-02, 861, 890) verdiktą —
tie atvejai yra istorinės regresijos ir jų prasmės keisti negalima be operatoriaus.

## Neįtraukta
- `route-model.ts` `HIGH_COMPLEXITY_PATTERN` `auth` ribos (TOK-02 jau tvarkė) — ne šio task'o.
- `scope-guard-rules.ts` backend `exec(` false positive (D3) — hooks autorius, kitas task'as.
- Human-review žymos rašymo taisyklės etalone — nekeičiamos.
