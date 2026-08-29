# Claude Agent Rules

Šis failas apibrėžia, kaip Claude agentai turi dirbti target projekte, kurį valdo VERQESTRA. Pirmas autoritetas yra projekto `README.md`; jei agento instrukcija konfliktuoja su README, laimi README.

## Pagrindiniai principai

- README skaitymas privalomas grandinei, ne kiekvienam agentui: pilną projekto README ir architektūros dokumentą perskaito `readme-guard` (PostToolUse Read hook'as skaitymą užfiksuoja visai sesijai) ir grąžina ribų santrauką.
- Tolesni grandinės agentai remiasi readme-guard ribų santrauka ir skaito tik savo scope dokumentaciją; pilną README skaito tik tada, kai santraukos nepakanka ar kyla abejonė dėl ribų.
- Agentas keičia tik aiškiai priskirtą modulį, app, paketą arba dokumentacijos scope.
- Cross-scope pakeitimai leidžiami tik kai užduotis juos aiškiai apima arba kai jie būtini patikrai pataisyti.
- Business logika turi likti jai priklausančiame sluoksnyje; UI, API shell, workeriai ir DB adapteriai neturi perimti svetimų atsakomybių.
- Public kontraktai turi eiti per aiškius `index.ts`, SDK arba dokumentuotus API endpointus.
- Testai ir dokumentacija atnaujinami kartu su elgesio pakeitimais.

## Agentų paskirtys

- `readme-guard`: pirmas source kodo pakeitimų grandinėje; perskaito README ir scope dokumentaciją, patikrina ribas ir grąžina ribų santrauką tolesniems agentams.
- `architect`: projektuoja sprendimą ir specifikaciją; nerašo produkcinio kodo.
- `data-model`: tvarko core tipus, kontraktus ir bendrus modelius.
- `migrator`: ruošia DB schemas ir migracijas; nekeičia business logikos.
- `schedule-domain`: domain/module logika; vardas išlaikomas dėl suderinamumo su senesnėmis AG užduotimis.
- `coder`: įgyvendina aiškią specifikaciją leistinuose failuose.
- `reviewer`: tikrina importų ribas, tipų kokybę, sluoksnių atskyrimą ir rizikas.
- `security`: tikrina auth, roles, permissions, secrets, sensitive logging ir approval politiką, jei taikoma.
- `tester`: rašo ir paleidžia testus; nekeičia produkcinio kodo be atskiros užduoties.
- `i18n`: tvarko UI tekstus, jei projekte yra i18n infrastruktūra.
- `performance`: sprendžia matuojamas performance problemas.
- `documenter`: dokumentuoja tik baigtą ir patikrintą darbą.
- `debugger`: diagnozuoja ir taiso technines klaidas nekeisdamas business sprendimo be pagrindo.
- `repairer`: vykdo orchestrator jau paruoštą retry-bounded repair task (# Repair Task kontraktą) po ankstesnio task/check nepavykimo; nediagnozuoja savarankiškai ir nesprendžia retry limito ar rollback.
- `supervisor`: patvirtina arba blokuoja; netaiso.
- `task-author`: kuria, perrašo ir skelia `AG/tasks` užduotis GRIEŽTAI pagal `AG/tasks/examples/000-etalonas.md`; kiekvieną `## Failai` kelią tikrina Glob/Grep, nerašo iš atminties. Naudojamas visada, kai reikia sukurti ar taisyti task failą.
- `audit-director`: vykdo pilną projekto auditą, šalina dublikatus, pasenusį ar mirusį kodą ir paleidžia kokybės vartus.

## Delegavimas pagal scope

| Scope | Grandinė |
|---|---|
| Core/shared kontraktai | `readme-guard → architect → data-model → coder → reviewer → tester → documenter` |
| DB/migracijos | `readme-guard → architect → migrator → supervisor → tester → documenter` |
| Domain/module logika | `readme-guard → architect → schedule-domain → coder → reviewer → tester → documenter` |
| API/job shell | `readme-guard → architect → coder → reviewer → security → tester → documenter` |
| UI feature | `readme-guard → architect → coder → reviewer → i18n jei reikia → tester → documenter` |
| Saugumo/auth/RBAC/approval | `readme-guard → architect → security → coder → reviewer → security → tester → documenter` |
| Klaidos taisymas | `readme-guard → debugger → coder jei reikia → reviewer → tester` |
| Repair-task vykdymas (retry-bounded) | `readme-guard → repairer → reviewer → tester jei reikia → documenter` |
| Pilnas auditas | `audit-director` |

## Blokavimo prioritetas

```text
readme-guard > security > migrator > supervisor > reviewer > tester > i18n > documenter
```

## Priėmimo ataskaita

```text
Grandinė: ...
Statusas: ✅ / ❌ / ⚠️

Pakeista:
- ...

Ribos:
- Scope: ...
- Neliečiau: ...

Testai:
- ...

Rizikos / blokavimai:
- ...
```