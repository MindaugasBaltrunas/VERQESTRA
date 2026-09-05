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
`docs/audits/full-audit-2026-09-05.md` P1-Dk3: `preflight-rules.ts:283` ir `audit-director.ts:138` generuoja/injektuoja tekstą su `logs/commit-msg.md` be `vq/` prefikso į task'ų `## Stop` sekcijas ir audit-director prompt'us. Stop hook'as tikruose runtime keliuose skaito `vq/logs/commit-msg.md` (`on-stop-context.ts`, `on-stop.ts`) — dabartinis literalas klaidina agentus ir gali praleisti autorinę commit žinutę.

## Agentai
readme-guard -> documenter

## Failai
Leidžiama:
- `src/application/quality-gates/preflight-rules.ts`
- `src/tests/quality-gates-preflight.test.ts`
- `src/interfaces/cli/audit/audit-director.ts`
- `src/tests/interfaces-cli-audit-director-prompt.test.ts`

Draudžiama:
- `src/tests/interfaces-cli-audit.test.ts`
- `src/domain/policies/readme-guard.ts`
- `.claude/**`
- `templates/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `preflight-rules.ts` eilutėje su sintetinio `## Stop` default tekstu pakeisti `logs/commit-msg.md` → `vq/logs/commit-msg.md`; `quality-gates-preflight.test.ts` pridėti aserciją, kad rezultatas mini `vq/logs/commit-msg.md`, ne `logs/commit-msg.md` be prefikso.
- `audit-director.ts` eilutėje su „Taisymo taisyklės" tekstu pakeisti tą patį literalą; naujame `interfaces-cli-audit-director-prompt.test.ts` per fake portus fiksuoti `auditDirectorCommand` paduodamą prompt'ą ir patvirtinti regex `(^|[^/])logs/commit-msg` be `vq/` neranda.
- Grep abiejuose failuose patvirtinti 0 senų `logs/commit-msg.md` be `vq/` formų.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Jei `src/tests/task-execution-rules.test.ts` ar kitas testas literalu tvirtina `logs/commit-msg.md` be `vq/` kaip preflight-rules IŠVESTĮ (ne kaip fixture įvestį), sustok ir klausk — tas testas eina į scope per accept-scope, ne apeinamas.

## Neįtraukta
- `.claude/agents/*.md` ir `templates/.claude/agents/*.md` — atliktos atskirose (ankstesnėse) užduotyse.
- `DEFAULT_ARCHITECTURE_DOC` domain konstanta — kito autoriaus scope.
