# Task

## Spec source
AG/openspec/changes/verqestra-backlog-v1/

## Priklausomybės
Šaknies `.claude/agents/*.md` task'as (tas pats backlog radinys, kita failų aibė) — atlikti tą patį pakeitimą, kad abu medžiai liktų sinchronizuoti.

## Tikslas
`docs/audits/full-audit-2026-09-05.md` P1-Dk3: tas pats 3 kelio formų pataisymas kaip šaknies `.claude/agents/*.md`, bet `templates/.claude/agents/` medyje — šablonai turi likti byte-identiški šakniai. Formos: `AG/project/profile.json`, `logs/commit-msg.md`, `doc/architecture/README.md`.

## Agentai
readme-guard -> documenter

## Failai
Leidžiama:
- `templates/.claude/agents/readme-guard.md`
- `templates/.claude/agents/architect.md`
- `templates/.claude/agents/coder.md`
- `templates/.claude/agents/migrator.md`
- `templates/.claude/agents/tester.md`
- `templates/.claude/agents/supervisor.md`
- `templates/.claude/agents/documenter.md`
- `templates/.claude/agents/audit-director.md`

Draudžiama:
- `.claude/agents/*.md`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Kiekviename iš 8 failų pakeisti tris senas formas: `AG/project/profile.json` → `vq/project/profile.json`; `logs/commit-msg.md` → `vq/logs/commit-msg.md`; `doc/architecture/README.md` → `docs/architecture.md`.
- Palyginti (Read) kiekvieną `templates/.claude/agents/X.md` su atitinkamu `.claude/agents/X.md` — po pakeitimo jie turi būti byte-identiški.
- Grep patvirtinti: `AG/project/profile\.json|logs/commit-msg\.md|doc/architecture/README\.md` per `templates/.claude/agents/` grąžina 0.

## Patikra
- `pnpm test`

## Stop
Commit'ink, kai abu medžiai byte-identiški ir `pnpm test` žalias. Jei šaknies ir templates versijos jau nesutampa dėl kitos priežasties (ne šio radinio), sustok ir klausk.

## Neįtraukta
- `.claude/agents/*.md` — atlikta atskiroje (pirmoje) užduotyje.
- `src/**` literalai — kita child užduotis.
- `task-author.md` kopija į šablonus, `agents.json` — task 220.
