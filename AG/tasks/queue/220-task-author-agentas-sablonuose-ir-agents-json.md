# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 219-agentu-failu-keliai-vq-project-vq-logs-docs-architecture

## Žingsnis 0 — ar jau įgyvendinta?
Jei egzistuoja `templates/.claude/agents/task-author.md` (byte-identiškas
`.claude/agents/task-author.md`), `templates/.claude/rules/agents.md` turi `task-author`
paskirties bullet'ą ir lentelės eilutę, o `templates/vq/config/agents.json` `roles` turi
`task-author` — ALREADY_IMPLEMENTED: cituok visus tris.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-Dk4 ir P2 docs 42 (2026-09-05),
`audit-docs.md` 19, 42: šaknies `CLAUDE.md` („Užduočių kūrimas — PRIVALOMA per etaloną")
`task-author` agentą daro privalomu, `.claude/rules/agents.md` jį aprašo, bet
`templates/.claude/agents/` neturi `task-author.md` (Glob 2026-09-05: 16 failų be jo),
`templates/.claude/rules/agents.md` neturi jo įrašo, `templates/vq/config/agents.json`
`roles` (16 vaidmenų) — taip pat ne. Target projektas po `verqestra install` gauna taisyklę
be agento. Papildomai `templates/vq/config/architecture-rules.md:39-46` „Common generic
chains" (feature: `… -> tester -> documenter`; data/schema be `supervisor`) nesutampa su
`.claude/rules/agents.md` lentele (Core: `… data-model → coder …`; DB: `… migrator →
supervisor …`) — dvi tiesos apie grandines viename šablonų medyje.

Šaknies `vq/config/agents.json` yra gitignored runtime (`.gitignore:11`) — jį papildo
operatorius komanda `verqestra agent add task-author` (Neįtraukta).

## Agentai
readme-guard -> documenter

## Failai
Leidžiama:
- `templates/.claude/agents/task-author.md` (numatomas naujas — kopija iš
  `.claude/agents/task-author.md`)
- `templates/.claude/rules/agents.md`
- `templates/vq/config/agents.json`
- `templates/vq/config/architecture-rules.md`

Draudžiama:
- `.claude/agents/task-author.md` (šaltinis, nekeičiamas)
- `.claude/rules/agents.md` (jau turi įrašą)
- `vq/config/agents.json` (runtime, gitignored — operatoriaus veiksmas)
- `templates/.claude/agents/*.md` išskyrus naują `task-author.md` (task 219 keičia kelius)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Sukurti `templates/.claude/agents/task-author.md` — byte-identišką `.claude/agents/
  task-author.md` turiniui (po 219 šaknies failas jau su teisingais keliais).
- `templates/.claude/rules/agents.md`: bullet'as `task-author` „Agentų paskirtys" sąraše
  (formuluotė iš šaknies `.claude/rules/agents.md`) ir eilutė „Delegavimas pagal scope"
  lentelėje (`AG/tasks užduoties kūrimas/skėlimas | task-author`), kaip šaknyje.
- `templates/vq/config/agents.json` `roles`: `"task-author": { "allowed_adapters":
  ["claude"], "default_model_hint": "sonnet", "can_write_code": false }` — rašo tik
  `AG/tasks/**` markdown'ą, ne kodą (laukai pagal `agent-policy.ts:44-51` schemą).
- `templates/vq/config/architecture-rules.md:39-46`: grandines suderinti su
  `.claude/rules/agents.md` lentele (Core/DB/Domain/API/UI/Saugumas/Klaidos/Repair/docs) ir
  pridėti `task-author` eilutę; vienas šaltinis — `agents.md`, `architecture-rules.md` tik
  cituoja.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `agents.json` schema (`agent-policy.ts`)
reikalauja laukų, kurių `task-author` vaidmeniui nėra prasmingos reikšmės (pvz.
`requires_human_review_for_global_changes`) — tada laukas praleidžiamas, ne išgalvojamas.

## Neįtraukta
- Šaknies runtime `vq/config/agents.json` — gitignored; operatorius paleidžia
  `verqestra agent add task-author` (arba `enable`, jei įrašas jau yra).
- `templates/.claude/agents/*.md` kelių pataisa — task 219.
- `agents.json` schema ar `agent` komandos elgesys — nekeičiami.
