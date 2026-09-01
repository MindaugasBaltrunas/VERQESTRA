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

## Priklausomybės
- 115-discard-stale-terminaliniam-taskui-nebesikartoja-kas-starta

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/run-budget.ts` (dabar `spentBillableTokens`
52-55 eil. sumuoja VISĄ `token-usage.jsonl`) arba sumuoja tik einamojo run
pjūvį, arba raktas/dokumentacija aiškiai deklaruoja LIFETIME semantiką (ne
„run") — ALREADY_IMPLEMENTED: cituok pasirinktos šakos kodą/doc'ą ir testą
kaip įrodymą.

## Tikslas
Audito P3, reikalingas architekto sprendimas: `run-budget.ts` vardas ir
semantika prieštarauja vienas kitam. Patikrinta (kelias —
`src/application/scheduling/run-budget.ts`, NE token-governance): raktas
`RUN_BUDGET_CONFIG_KEY = "maxRunBillableTokens"` (19 eil.) žada RUN ribą,
bet `spentBillableTokens` (52-55) sumuoja per VISĄ `vq/logs/
token-usage.jsonl` — append-only viso gyvavimo žurnalą (kontraktas
`domain/tokens/usage-ledger.ts`), ir paties failo doc'as (48 eil.) sako
„sumuojama per VISUS įrašus". Pasekmė: operatoriui deklaravus
`maxRunBillableTokens`, riba išsenka VISAM LAIKUI — kiekvienas naujas run
paveldi visų ankstesnių išlaidas, ir `exhausted: true` (67 eil.) tampa
negrįžtamas be rankinio žurnalo valymo. Šiandien LATENTINIS (raktas
nedeklaruotas → 65 eil. `undefined`, niekas neblokuojama), bet wiring GYVAS
(`composition/loop/command.ts:212+` per `buildReadySet` biudžetą). Task'as
su architect ŽINGSNIU — dvi šakos: (A) run-scoped pjūvis — suma imama tik
nuo einamojo run pradžios (reikia run ribos signalo: run_id lauko įrašuose
ar run pradžios žymės; tikrinti, ką `usage-ledger` įrašai realiai neša);
(B) rakto/dokumentacijos pervadinimas į lifetime semantiką (pvz.
`maxLifetimeBillableTokens`) — mechanika lieka, melagingas vardas dingsta,
o run-scoped ribos poreikis fiksuojamas kaip atskiras backlog'as.
Priklausomybė nuo 115 — reali deklaruotų kelių sankirta:
`composition/loop/command.ts` yra 115 Leidžiama sąraše, o (A) šakai jo
wiring'as gali keistis.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/run-budget.ts`
- `src/application/scheduling/build-ready-set.ts` (TIK 123 eil. doc
  komentaras, jei semantika/vardas keičiasi)
- `src/composition/loop/command.ts` (TIK (A) šaka — run ribos signalo
  padavimas portui; (B) šakoje neliečiamas)
- `src/tests/scheduling-run-budget.test.ts`

Draudžiama:
- `src/domain/tokens/usage-ledger.ts` (append-only kontraktas ir aritmetika
  nekinta — (A) šaka skaito, ne keičia)
- `vq/config/token-budget.json` runtime failai
- `dist/**`
- `node_modules/**`

## Veiksmas
- ŽINGSNIS 1 (architect, PRIEŠ kodavimą): verdiktas (A) ar (B) su pagrindimu
  ataskaitoje. Svarstyti: (A) duoda operatoriui realiai naudingą per-run
  ribą, bet reikalauja patikimo run pradžios signalo (jei `usage-ledger`
  įrašai neneša run_id — signalo įvedimas gali plėsti scope už šio task'o:
  tada Stop); (B) pigus ir sąžiningas, bet palieka run-ribos poreikį
  neišspręstą.
- (A) šaka: `spentBillableTokens` gauna run pjūvio ribą (filtras pagal
  run_id ar laiko žymę nuo run pradžios), `RunBudgetPorts` praplečiamas
  signalu, `command.ts` jį suriša; doc'ai (1-13, 45-51) atnaujinami.
- (B) šaka: naujas raktas su lifetime vardu; senas `maxRunBillableTokens`
  raktas — pereinamoji logika (skaitomas su deprecation log eilute ar
  atmetamas su aiškia žinute — vykdytojo sprendimas, pagrįstas ataskaitoje);
  doc'ai atnaujinami, kad „run" nebeklaidintų.
- Testų lūkestis: (A) — dviejų run'ų žurnalas: antro run pjūvis nemato
  pirmo išlaidų; riba išsenka ir atsistato su nauju run. (B) — naujas
  raktas veikia, seno rakto kelias elgiasi pagal pasirinktą pereinamąją
  logiką; abiem šakom esami `undefined`/`exhausted` testai žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei (A) šakai paaiškėtų,
kad `usage-ledger` įrašai neturi jokio run atribucijos lauko ir jo įvedimas
keistų žurnalo schemą (visų rašytojų/skaitytojų kontraktas — atskiras
sprendimas).

## Neįtraukta
- Per-task biudžetų (`tool-budget.json`, `token-budget-status.json`)
  semantika — failo antraštės doc'as (7-10 eil.) jų atskyrimą jau pagrindžia.
- Žurnalo rotacijos/valymo politika — lifetime augimas yra atskiras
  klausimas.
- Jei pasirinkta (B): run-scoped ribos įgyvendinimas — fiksuojamas
  ataskaitoje kaip būsimo task'o kandidatas.
