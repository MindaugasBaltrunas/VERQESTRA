## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1 (task 067, 1/3 dalis; priklauso nuo 066)

## Tikslas
Application sluoksnyje leisti operatoriui atsaukti savo politikos pasiulyma: naujas sprendimo verb'as 'cancel' greta approve/reject/apply ir naujas zurnalo statusas 'cancelled'. Zurnalas lieka append-only.

Zingsnis 0: jei 'cancel' verb'as ir 'cancelled' statusas jau egzistuoja - ALREADY_IMPLEMENTED, nieko nekeisk, praneskite ataskaitoje.

## Agentai
Privaloma naudoti butent sia grandine: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidziama:
- `src/application/policy-governance/policy-proposal-service.ts`
- `src/application/policy-governance/policy-proposals-log.ts`
- `src/tests/policy-governance-proposals.test.ts`

Jei pasiulymu testai realiai gyvena kitame faile (pvz. `src/tests/policy-proposals.test.ts`) - keisk ta faila vietoje numatyto ir irasyk tikslu kelia i ataskaita.

Draudziama:
- `src/interfaces/http/ui-router-mutations.ts`
- `ui-app/src/App.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Isplesti `PolicyDecisionVerb` reiksme 'cancel' ir zurnalo statusa 'cancelled'; atsaukimas rasomas kaip NAUJAS irasas, jokio esamu irasu trynimo ar perrasymo.
- `decidePolicyProposal`: atsaukti leidziama 'pending' ir 'approved' (dar nepritaikyta) pasiulyma; is 'applied' arba 'rejected' - grazinti konflikto rezultata su paaiskinimu (HTTP statuso mapping paliekamas kitai uzduociai).
- Testai: cancel is pending, cancel is approved, konfliktas is applied ir is rejected, ir kad zurnalo irasu skaicius po atsaukimo tik padidejo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros zalios. Sustok ir klausk, jei tektu keisti HTTP route, ui-app failus arba silpninti esama testa.

## Neitraukta
HTTP route regex ir 409 atsakas (2/3 dalis). UI mygtukas 'Atsaukti', i18n tekstai, CSS, History zenklelis (3/3 dalis). Masinis atsaukimas. Jau pritaikytu ('applied') pakeitimu atstatymas.
