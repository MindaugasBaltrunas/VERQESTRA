# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei egzistuoja `templates/AG/tasks/examples/000-etalonas.md`; `templates/CLAUDE.local.md` ir
`templates/AG/openspec/project.md` neturi `TODO:`; `templates/vq/config/commands.env` neturi
`AG_ROLLBACK_CLEAN` kaip veikiančio rakto (arba turi komentarą, kad jis skaitomas TIK iš
proceso env) ir dokumentuoja `AG_UI_PORT`; `templates/vq/config/models.env` neturi
`CLAUDE_COMMAND` ir turi `CLAUDE_FABLE_MODEL`; `task-classification-policy.json` `_comment`
ir `pathIncludes` rodo VERQESTRA kelius — ALREADY_IMPLEMENTED: cituok kiekvieną. Tikrink po
punktą.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-Dk2, P1-Dk5, P2 docs 24, 33, 35, 37,
39 (2026-09-05); `audit-docs.md` 14, 15, 24, 33, 35, 37, 39:
- Dk2 ✓: `templates/vq/config/commands.env:6-8` `AG_ROLLBACK_CLEAN=0` su „Set to 1 …" —
  kodas skaito TIK `process.env` (`src/composition/runtime/bootstrap-adapters.ts:245-247`);
  `commands.env` krautuvai ima tik `MAX_RETRIES_PER_ERROR` (`loop/adapters.ts:173-174`) ir
  `AG_UI_PORT` (`ui-port-store.ts:144`). Reikšmė faile tyliai ignoruojama. `models.env:9`
  `CLAUDE_COMMAND=claude` — 0 skaitytojų `src/**`. Kartu: `AG_UI_PORT` skaitomas iš
  `commands.env`, bet šablone nedokumentuotas (24); `CLAUDE_FABLE_MODEL` skaitomas
  (`claude-model-env.ts:150`, tylus default `claude-fable-5`), šablone nėra (33).
- Dk5: `templates/AG/tasks/` neturi `examples/000-etalonas.md`, nors deterministiniai vartai jį
  cituoja kaip taisyklių šaltinį (`domain/tasks/etalonas-rules.ts:13`, `preflight-llm.ts:23`),
  o `runtime-dirs.ts:18` kuria tuščią `examples/` — target projekte vartai cituoja
  neegzistuojantį failą (39). `templates/CLAUDE.local.md:6` ir
  `templates/AG/openspec/project.md:7-19` neša `TODO:` į target šaknį (37).
- 35: `task-classification-policy.json:3` `_comment` rodo etalono kelius
  (`policy/task-classification.ts`, `policy/route-model.ts`, `domain/tasks/human-review.ts`);
  VERQESTRA: `src/domain/policies/task-classification.ts`,
  `src/application/token-governance/route-model.ts`, `src/domain/tasks/human-review/gates.ts`.
  `pathIncludes` `src/commands/`, `src/orchestrator/`, `AG/orchestrator/src/core/` — etalono
  keliai, neegzistuojantys nei čia, nei target'e.
Mirusių šablonų (`mcp-policy.json`, `browser-policy.json`, `research-policy.json`,
`vq/schemas/*.schema.json`) TRYNIMAS sandbox'e negalimas — Neįtraukta.

## Agentai
readme-guard -> documenter

## Failai
Leidžiama:
- `templates/AG/tasks/examples/000-etalonas.md` (numatomas naujas — kopija iš
  `AG/tasks/examples/000-etalonas.md`)
- `templates/CLAUDE.local.md`
- `templates/AG/openspec/project.md`
- `templates/vq/config/commands.env`
- `templates/vq/config/models.env`
- `templates/vq/config/task-classification-policy.json`
- `src/tests/gate-install-covers-smoke.test.ts`

Draudžiama:
- `AG/tasks/examples/000-etalonas.md` (šaltinis; keitimui reikia atskiro operatoriaus
  pavedimo)
- `src/composition/runtime/bootstrap-adapters.ts` ir `src/composition/loop/adapters.ts`
  (`commands.env` skaitymo kodo pusė — loop autorius)
- `templates/vq/config/{mcp-policy,browser-policy,research-policy}.json`
- `templates/vq/schemas/**`
- `templates/vq/config/agents.json` (task 220)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Sukurti `templates/AG/tasks/examples/000-etalonas.md` — byte-identišką šaknies etalonui
  (be turinio redagavimo).
- `templates/CLAUDE.local.md`: `TODO:` eilutę pakeisti neutraliu skeleto tekstu (antraštės
  „Portai", „Env failai", „Komandų ypatumai" su tuščiais bullet'ais) — be žodžio `TODO`.
- `templates/AG/openspec/project.md`: keturias `TODO:` eilutes pakeisti trumpu aprašomuoju
  sakiniu („Užpildo projekto komanda: …") be `TODO`.
- `templates/vq/config/commands.env`: `AG_ROLLBACK_CLEAN` eilutę ir jos komentarą pakeisti
  komentaru, kad `AG_ROLLBACK_CLEAN=1` galioja TIK kaip proceso env kintamasis (iki loop
  autoriaus kodo pataisos), pridėti dokumentuotą `AG_UI_PORT` (užkomentuotą pavyzdį su
  paaiškinimu: env > commands.env > ui-server.json). `MAX_RETRIES_PER_ERROR=4` lieka —
  `gate-install-covers-smoke.test.ts:74-94` reikalauja bent vienos priskyrimo eilutės.
- `templates/vq/config/models.env`: pašalinti `CLAUDE_COMMAND`; pridėti
  `CLAUDE_FABLE_MODEL=claude-fable-5` su komentaru; alias'ų/pilnų vardų formą suderinti su
  `claude-model-env.ts:147-150` default'ais (komentare paaiškinti, kad `haiku|sonnet|opus`
  yra Claude CLI alias'ai).
- `task-classification-policy.json`: `_comment` keliai → VERQESTRA; `pathIncludes`
  `src/commands/`, `src/orchestrator/`, `AG/orchestrator/src/core/` pakeisti į kelius, kurie
  egzistuoja VERQESTRA/target'e (`src/interfaces/cli/`, `src/composition/`, `src/application/
  scheduling/`) — patikrinti prieš `task-classification-defaults.ts:26,33`, kad šablonas ir
  kodo default'as sutaptų (komentaras sako „veidrodis").
- `gate-install-covers-smoke.test.ts`: jei asercijos priklauso nuo konkretaus rakto —
  atnaujinti; kitaip nekeisti, tik paleisti.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `task-classification-defaults.ts`
(`src/domain/**`, uždrausta) `pathIncludes` turi tuos pačius etalono kelius ir šablonas be
kodo pataisos nustotų būti veidrodis — tada `pathIncludes` NEKEIČIAMI, taisomas tik
`_comment`, o kodo pusė įrašoma į ataskaitą kaip domain autoriaus darbas.

## Neįtraukta
- Mirusių šablonų trynimas (`mcp-policy.json`, `browser-policy.json`, `research-policy.json`,
  `vq/schemas/codex-preflight.schema.json`, `supervisor-diagnosis.schema.json`) —
  OPERATORIAUS VEIKSMAS: jokia `rm`/`git rm` forma sandbox'e neallowlist'inta.
- `AG_ROLLBACK_CLEAN` skaitymas iš `commands.env` kode — loop autorius.
- `task-classification-defaults.ts` kodo default'ų keitimas — domain scope.
- `templates/README.md:3` (`pnpm verqestra install` su `private` paketu) — neįtraukta į šią
  partiją (audito 36).
