## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
AG/openspec/changes/verqestra-backlog-v1/

## Tikslas
`docs/audits/full-audit-2026-09-05.md` P1-Dk3: 8 failuose `.claude/agents/*.md` yra 3 pasenusios kelio formos (Grep patvirtinta 2026-09-05): `AG/project/profile.json` (kodas skaito `vq/project/profile.json`), `logs/commit-msg.md` (Stop hook'as skaito `vq/logs/commit-msg.md`), `doc/architecture/README.md` (repo turi `docs/architecture.md`). Agentai instruktuojami skaityti/rašyti neegzistuojančius kelius.

## Agentai
readme-guard -> documenter

## Failai
Leidžiama:
- `.claude/agents/readme-guard.md`
- `.claude/agents/architect.md`
- `.claude/agents/coder.md`
- `.claude/agents/migrator.md`
- `.claude/agents/tester.md`
- `.claude/agents/supervisor.md`
- `.claude/agents/documenter.md`
- `.claude/agents/audit-director.md`

Draudžiama:
- `templates/.claude/agents/*.md`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Kiekviename iš 8 failų pakeisti tris senas formas į naujas: `AG/project/profile.json` → `vq/project/profile.json`; `logs/commit-msg.md` → `vq/logs/commit-msg.md`; `doc/architecture/README.md` → `docs/architecture.md` (readme-guard.md description eilutėje, Žingsnis 1 sąraše ir ataskaitos šablone taip pat).
- Perskaityti (Read) kiekvieną pakeistą failą po redagavimo, patikrinti teksto nuoseklumą.
- Grep patvirtinti: `AG/project/profile\.json|logs/commit-msg\.md|doc/architecture/README\.md` per `.claude/agents/` grąžina 0.

## Patikra
- `pnpm test`

## Stop
Commit'ink, kai Grep patvirtinimas rodo 0 senų formų ir `pnpm test` žalias. Jei kuris nors failas turi papildomą sakinį, kuriame kelio pakeitimas keistų agento elgesio semantiką (ne vien kelią), sustok ir klausk.

## Neįtraukta
- `templates/.claude/agents/*.md` — atskira užduotis (child task, identiškas pakeitimas kitame medyje).
- `src/application/quality-gates/preflight-rules.ts` ir `src/interfaces/cli/audit/audit-director.ts` literalai — atskira užduotis (child task).
- `DEFAULT_ARCHITECTURE_DOC` domain konstanta, `task-author.md`, `agents.json`, `.claude/rules/workflow.md` — kitų task'ų (220, 222) scope.
