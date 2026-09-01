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

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/policy-governance/policy-proposal-service.ts`
`buildPolicyProposal` (dabar 119-141 eil.) lygina `current[setting_id]` su
`requested_value` ir sutapimo atveju meta tipizuotą klaidą, kurią
`src/interfaces/http/ui-error-mapping.ts` `mapPolicyDecisionError` paverčia
4xx — ALREADY_IMPLEMENTED: cituok palyginimo eilutes ir mapping šaką kaip
įrodymą.

## Tikslas
UI audito P1 (docs/audits/ui-app-2026-08-31/report.md, „Politikos forma
leidžia siųsti `layered → layered`"): pasiūlymas su reikšme, lygia dabartinei,
priimamas ir kuria beprasmį valdymo įrašą. Patikrinta 2026-09-01 serverio
pusėje: `buildPolicyProposal`
(`src/application/policy-governance/policy-proposal-service.ts:119-141`)
nuskaito `current[setting_id]` į `old_value` (135 eil.), bet NIEKUR nelygina
jo su `requested_value` — validuojama tik schema (130 eil.), tad no-op praeina
visą kelią iki `proposals.jsonl`. HTTP sluoksnis
(`src/interfaces/http/ui-router-mutations.ts:318-336` `proposePolicyChange`)
atmeta tik tuščią `setting_id`. Sprendimas — serverio pusėje atmesti no-op
tipizuota klaida pagal esamą šio modulio klaidų šeimos pavyzdį
(`ProposalNotApprovedError` ir kt., kurias `mapPolicyDecisionError`
`src/interfaces/http/ui-error-mapping.ts:127-140` paverčia į 400/403/409):
vartotojo klaida niekada nėra 500, o čia tai vartotojo įvestis. UI pusės
disable — atskiras task'as 104, kuris priklauso nuo šio kontrakto.

## Agentai
readme-guard -> architect -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/application/policy-governance/policy-proposal-service.ts`
- `src/interfaces/http/ui-error-mapping.ts`
- `src/interfaces/http/ui-router-mutations.ts` (tik jei atmetimui reikia
  keisti route handler'į — tikėtina, kad ne: klaida turi tekėti per esamą
  catch → mapping kelią)
- `src/tests/policy-proposals.test.ts`
- `src/tests/interfaces-http-router.test.ts`
- `src/tests/interfaces-http-router-contracts.test.ts`

Draudžiama:
- `src/application/policy-governance/policy-proposals-log.ts` (žurnalo schema
  ir append logika nekeičiama)
- `src/application/policy-governance/policy-file-registry.ts`
- `ui-app/**` (UI pusė — task 104)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `policy-proposal-service.ts` (`buildPolicyProposal`): po dabartinės reikšmės
  nuskaitymo palyginti `current[setting_id]` su `requested_value` GILIA
  lygybe (reikšmės yra JSON tipo; `Object.is`/`===` nepakanka objektams) —
  sutapimas meta naują tipizuotą klaidą (pvz. `ProposalNoOpError`) su žinute,
  įvardijančia nustatymą ir reikšmę.
- `ui-error-mapping.ts`: naujas `PolicyErrorKind` narys ir šaka
  `mapPolicyDecisionError` — statusą (400 kaip netinkama įvestis ar 409 kaip
  būsenos konfliktas) pasirenka ir doc-komentare pagrindžia vykdytojas pagal
  esamą failo taisyklių stilių (88-117 eil.).
- Testų lūkestis: (1) `policy-proposals.test.ts` — no-op pasiūlymas meta
  tipizuotą klaidą ir NIEKO nerašo į žurnalą; skirtinga reikšmė toliau
  praeina; (2) `interfaces-http-router.test.ts` — POST su sutampančia
  reikšme grąžina pasirinktą 4xx su klaidos žinute kūne;
  (3) kontraktų testas atnaujinamas, jei jis fiksuoja atsakymų aibę.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad no-op
atmetimas laužo esamą CLI kelią (`src/interfaces/cli/admin/policy.ts` irgi
kviečia proposal kelią) taip, kad CLI vartotojui reikėtų kito elgesio nei
HTTP — tai būtų kontrakto šakojimas, kurį turi patvirtinti operatorius.

## Neįtraukta
- Dubliuotų PENDING pasiūlymų (tas pats failas+nustatymas+reikšmė) grupavimas
  ar deduplikacija — report rekomendacijos 4 punktas, atskiras task'as:
  reikia pending aibės skaitymo strategijos, kuri už šio task'o ribų.
- UI disable ir paaiškinimas formoje — task 104.
- `reason` lauko semantika — 2026-08-28 operatoriaus sprendimas
  (neprivalomas) nekvestionuojamas.
