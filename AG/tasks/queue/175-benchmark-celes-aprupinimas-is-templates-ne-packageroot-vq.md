# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/runtime/integration-adapters.ts` `provisionLoopRuntime` (201-231) agentų ir
konfigo šaltiniu naudoja `templates/.claude/agents` ir `templates/vq/config` (ne
`packageRoot()/.claude/agents` ir `packageRoot()/vq/config`) — ALREADY_IMPLEMENTED: cituok
`sourceDir`/`configDir` eilutes ir `src/tests/composition-loop-cell-provisioning.test.ts` atvejį.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 „Loop": „benchmark celė
aprūpinama iš `packageRoot()/vq/config` — ne paketo `files`"; pilna ataskaita
`audit-composition.md` P2-7): `integration-adapters.ts:207-228` kopijuoja `.claude/agents/*.md` ir
`vq/config/*` iš `packageRoot()`. Nei `vq/` (gitignored), nei `.claude/` nėra paketo `files`
(`release-check-adapters.ts:137`), tad už dev checkout'o ribų `listFiles` → ENOENT → `[]` →
`agents: 0` → celė VISADA atsisako (fail-closed vartai, kurie 2026-08-22 pilote jau atmetė 9
celes dėl kito šaltinio). `install` komanda tuos pačius failus diegia iš `templates/` — tai ir yra
kanoninis paketo šaltinis.

Kryptis: šaltinis — `templates/.claude/agents` ir `templates/vq/config` (patikrinti, kad
`templates/` yra `package.json` `files`); `packageRoot()` lieka, keičiasi tik pokatalogis.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/runtime/integration-adapters.ts` (201-231)
- `src/tests/composition-loop-cell-provisioning.test.ts`

Draudžiama:
- `templates/**` (šaltinis skaitomas, nekeičiamas)
- `src/composition/quality/release-check-adapters.ts` (172 scope)
- `src/interfaces/cli/bootstrap/install.ts`
- `package.json`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `integration-adapters.ts` `provisionLoopRuntime`: `sourceDir = packageRoot()/templates/.claude/agents`,
  `configDir = packageRoot()/templates/vq/config`; komentaras 202-206 papildomas priežastimi
  (paketo `files` vs gitignored runtime). `agents.json` buvimo taisyklė (229-231) nekinta.
- Jei `templates/.claude/agents` neturi `task-author.md` (audito Dk4) — celė to nepastebi, nes
  roster'į valdo `agents.json`; į ataskaitą įrašyti, ne taisyti.
- `composition-loop-cell-provisioning.test.ts`: šaltinio keliai rodo į `templates/`; dev checkout'e
  su tuščiu `vq/config` celė vis tiek gauna `agents > 0`; be `templates/vq/config/agents.json`
  → `agents: 0` (nekinta).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `templates/` NĖRA `package.json` `files`
sąraše — tada `package.json` keitimas reikalauja operatoriaus patvirtinimo (constraints.md).

## Neįtraukta
- `templates/**` turinys (mirę policy šablonai, `task-author.md` trūkumas) — šablonų autorius.
- `pnpm test:benchmark` paleidimas — `AG/benchmark` ne `pnpm test` dalis (CLAUDE.md); jei keičiama
  celės elgsena, operatorius paleidžia vardu.
