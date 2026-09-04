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
openspec/changes/verqestra-backlog-v1/

## Tikslas
Patikrinti, ar `DEFAULT_TURN_LIMITS` (`turn-budget.ts`) ir `resolveDispatchTurnTier` escalated šaka (`token-budget-optimizer.ts`) jau atitinka modelių audito R1–R3 sprendimą (medium 90, repair 45, eskaluotas bandymas → tier=large/source=escalated). Jei taip — NEDARYTI pakeitimų, ataskaitą pradėti `ALREADY_IMPLEMENTED:` eilute su konkrečiomis eilutėmis.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/token-governance/turn-budget.ts`
- `src/application/token-governance/token-budget-optimizer.ts`
- `src/tests/token-governance-turn-budget.test.ts`

Draudžiama:
- `src/application/token-governance/route-model.ts`
- `src/application/token-governance/token-budget-config.ts`
- `templates/vq/config/token-budget.json`
- `src/interfaces/**`
- `dist/**`

## Veiksmas
- Perskaityti `turn-budget.ts` DEFAULT_TURN_LIMITS ir patvirtinti medium=90, repair=45.
- Perskaityti `token-budget-optimizer.ts` resolveDispatchTurnTier escalated šaką ir patvirtinti tier=large/source=escalated elgesį bei kad soft reduced kelias eskaluotam bandymui netaikomas.
- Paleisti patikras; jei žalios ir kodas atitinka tikslą, ataskaitą pradėti `ALREADY_IMPLEMENTED:` su citatomis, be pakeitimų.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Jei kodas neatitinka tikslo (reikšmės skiriasi nuo 90/45 arba escalated šaka nerealizuota), sustok ir eskaluok — nedaryk pakeitimų be atskiro patvirtinimo.

## Neįtraukta
- `templates/vq/config/token-budget.json` patikra — atskiras child task.
- `dispatch-budget-plan.ts`/`command.ts` eskalacijos wiring patikra — atskiras child task.
