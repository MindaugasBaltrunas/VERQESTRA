# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei Grep `AG/project/profile\.json|logs/commit-msg\.md|doc/architecture/README\.md` per
`.claude/agents/` ir `templates/.claude/agents/` grąžina 0 (išskyrus `vq/logs/commit-msg.md`
ir `vq/project/profile.json` formas), `src/application/quality-gates/preflight-rules.ts:299`
ir `src/interfaces/cli/audit/audit-director.ts:138` rašo `vq/logs/commit-msg.md` —
ALREADY_IMPLEMENTED: cituok Grep rezultatą ir abi kodo eilutes.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-Dk3 ir P2 docs 31 (2026-09-05),
`audit-docs.md` 17, 18, 31. Grep 2026-09-05: 16 vietų 8 failuose KIEKVIENAME medyje
(`.claude/agents/` ir `templates/.claude/agents/`: readme-guard 5, audit-director 3,
documenter 2, supervisor 2, architect 1, coder 1, migrator 1, tester 1):
- `AG/project/profile.json` (readme-guard:19, architect:13, coder:13, supervisor:35,
  tester:37, audit-director:20) — kodas skaito `vq/project/profile.json`
  (`src/composition/hooks/guard-adapters.ts:43`, `pre-adapters.ts:68`,
  `quality/adapters.ts:55`, `compound-init.ts:149`). Agentai ribų ieško neegzistuojančiame
  faile.
- `logs/commit-msg.md` (audit-director:32, documenter:17) — Stop hook'as skaito
  `vq/logs/commit-msg.md` (`on-stop-context.ts:96`, `on-stop.ts:133`) → autorinė žinutė
  praleidžiama, commit'as gauna WIP fallback. Tą pačią klaidą į task tekstą injektuoja
  `preflight-rules.ts:299` (`## Stop` default) ir `audit-director.ts:138` (audit prompt'as);
  `application/scheduling/loop-empty-queue.ts:58` rašo teisingai `vq/logs/…`.
- `doc/architecture/README.md` (readme-guard:3,14,34,47, supervisor:16, migrator:13,
  documenter:13, coder:13, audit-director:13, architect:13) — repo turi `docs/architecture.md`;
  hook'as jo reikalauja tik jei egzistuoja (`domain/policies/readme-guard.ts:86-89`), tad
  agentai instruktuojami skaityti failą, kurio nėra.
Tai keičia realų loop'o elgesį (commit žinutės), todėl P1.

## Agentai
readme-guard -> documenter

## Failai
Leidžiama:
- `.claude/agents/*.md` (visos katalogo apimties pakeitimas: 8 iš 16 failų, 16 vietų, tas pats
  trijų kelių keitimas; sąrašas Tiksle)
- `templates/.claude/agents/*.md` (tas pats pagrindimas — šablonai byte-identiški šaknies)
- `src/application/quality-gates/preflight-rules.ts` (tik :299 literalas)
- `src/tests/quality-gates-preflight.test.ts`
- `src/interfaces/cli/audit/audit-director.ts` (tik :138 literalas)
- `src/tests/interfaces-cli-audit-director-prompt.test.ts` (numatomas naujas; NE
  `interfaces-cli-audit.test.ts` — jį lygiagrečiai keičia task 215)

Draudžiama:
- `src/tests/interfaces-cli-audit.test.ts` (task 215)
- `src/domain/policies/readme-guard.ts` (`DEFAULT_ARCHITECTURE_DOC` — domain, kito autoriaus)
- `.claude/rules/**` ir `templates/.claude/rules/**` (task 220, 222)
- `templates/vq/**` (task 220, 221)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Abiejuose medžiuose 8 agentų failuose: `AG/project/profile.json` → `vq/project/profile.json`;
  `logs/commit-msg.md` → `vq/logs/commit-msg.md`; `doc/architecture/README.md` →
  `docs/architecture.md` (readme-guard ataskaitos eilutėje :47 ir description :3 taip pat).
  Po pakeitimo šablonas ir šaknis lieka byte-identiški (patikrinti Read abiem).
- `preflight-rules.ts:299`: `logs/commit-msg.md` → `vq/logs/commit-msg.md`;
  `quality-gates-preflight.test.ts` — asercija, kad sintetinis `## Stop` mini
  `vq/logs/commit-msg.md`, o ne `logs/commit-msg.md` be prefikso.
- `audit-director.ts:138`: tas pats; naujas testas `interfaces-cli-audit-director-prompt.test.ts`
  per fake portus fiksuoja `auditDirectorCommand` paduodamą prompt'ą ir tvirtina
  `vq/logs/commit-msg.md` (regex `(^|[^/])logs/commit-msg` neturi rasti be `vq/`).
- Grep'ą iš Žingsnio 0 pakartoti pabaigoje — turi būti 0 senų formų.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `src/tests/task-execution-rules.test.ts`
ar kitas testas literalu tvirtina `logs/commit-msg.md` be `vq/` kaip preflight-rules IŠVESTĮ
(ne kaip fixture įvestį) — tada tas testas eina į scope per accept-scope, ne apeinamas.

## Neįtraukta
- `DEFAULT_ARCHITECTURE_DOC = "doc/architecture/README.md"` domain konstantos keitimas —
  kito autoriaus domain scope; hook'as failo be jo nereikalauja, tad agentų failai gali rodyti
  į `docs/architecture.md` nepriklausomai.
- `task-author.md` kopija į šablonus ir `agents.json` — task 220.
- `.claude/rules/workflow.md` `pnpm test:architecture` — task 222.
