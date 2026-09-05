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
Audito docs/audits/full-audit-2026-09-05.md P1-Dk5 ir P2 24/33/37/39: pašalinti TODO placeholder'ius iš templates/, atkurti trūkstamą templates/AG/tasks/examples/000-etalonas.md kopiją ir sutvarkyti commands.env/models.env raktus, kad šablonas atitiktų realų kodo skaitymą.

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
- Sukurti `templates/AG/tasks/examples/000-etalonas.md` — byte-identišką kopiją iš `AG/tasks/examples/000-etalonas.md` (be turinio redagavimo).
- `templates/CLAUDE.local.md`: `TODO:` eilutę pakeisti neutraliu skeleto tekstu (antraštės „Portai", „Env failai", „Komandų ypatumai" su tuščiais bullet'ais, be žodžio TODO); `templates/AG/openspec/project.md`: keturias `TODO:` eilutes pakeisti trumpu sakiniu „Užpildo projekto komanda: …" be žodžio TODO.
- `templates/vq/config/commands.env`: `AG_ROLLBACK_CLEAN` eilutę ir komentarą pakeisti komentaru, kad `AG_ROLLBACK_CLEAN=1` galioja TIK kaip proceso env kintamasis (kol nepataisyta loop autoriaus pusė), pridėti dokumentuotą užkomentuotą `AG_UI_PORT` pavyzdį (paaiškinimas: env > commands.env > ui-server.json); `MAX_RETRIES_PER_ERROR=4` palikti nepakeistą. `templates/vq/config/models.env`: pašalinti `CLAUDE_COMMAND`, pridėti `CLAUDE_FABLE_MODEL=claude-fable-5` su komentaru, kad `haiku|sonnet|opus` yra Claude CLI alias'ai (žr. src/composition/**/claude-model-env.ts default'us, tik skaityti, nekeisti).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Jei `gate-install-covers-smoke.test.ts` krenta dėl env formato — taisyk env failą, ne testą (testas tikrina tik `RAKTAS=reikšmė` formatą ir bent vieną priskyrimo eilutę, konkretaus rakto nereikalauja).

## Neįtraukta
- `templates/vq/config/task-classification-policy.json` — atskira užduotis (skirtingas failų rinkinys).
- Mirusių šablonų trynimas (`mcp-policy.json`, `browser-policy.json`, `research-policy.json`, `vq/schemas/**`) — operatoriaus veiksmas, sandbox'e trynimas neallowlist'intas.
- `AG_ROLLBACK_CLEAN` skaitymas iš `commands.env` kode — loop autoriaus scope.
