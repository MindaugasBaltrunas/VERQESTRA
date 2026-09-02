# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 150-allowed-paths-ima-tik-pirma-backtick-tokena-leidziama-bullete

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/tasks/allowed-paths.ts` `parseAllowedPaths` ir
`forbiddenPaths` bloką skaito ne po vieną eilutę (šiandien 119-121 ir
184-186 eil. `for (const line of block.split(...)) collectPathTokensFromLine`),
o bullet eilutę kartu su po jos einančiomis įtrauktomis tęstinėmis eilutėmis
sulanksto į VIENĄ įrašą ir iš jo ima tik pirmą backtick tokeną, ir
`src/tests/domain-tasks.test.ts` turi atvejį, kur backtick tokenas stovi
tęstinėje (įtrauktoje, be bullet žymeklio) eilutėje ir NEtampa keliu —
ALREADY_IMPLEMENTED: cituok sulankstymo funkciją ir testą.

## Tikslas
Įrodymas (`vq/logs/orchestrator.log`, 2026-09-02 UTC):
`[11:08:01] TASK HUMAN REVIEW: 116-pool-missing-lease-eilute-rodo-paskutine-provision-baigti budget_enforcement_failed=context files 10 > 8`
ir `[11:13:00] TASK HUMAN REVIEW: 143-pack-semantics-descriptor-apima-visas-derinimo-konstantas budget_enforcement_failed=context files 12 > 8`.
Abu preflight'ai prieš tai sakė `verdict=delegate ... scoped paths present`.
143 `## Failai / Leidžiama:` turėjo 5 kelius, 116 — 6; likę „failai" buvo
laužytų bullet'ų tęstinių eilučių pagrindimo identifikatoriai:
143 — `MIN_ARCHITECTURE_TOKEN_LENGTH`, `const`, `WARNING_SEVERITY`,
`SPEC_DROP_REFS_LISTED`, `SCORE_PRECISION`; 116 —
`WaveProvisioningCoordinator`, `provisionMissingSlotLeases`. Originali 143
forma: `` - `src/application/context-pack/assemble/gather.ts` (TIK ``
+ nauja eilutė `` MIN_ARCHITECTURE_TOKEN_LENGTH` eksportas — dabar failo vidinis `const`) ``.

Priežastis: task 150 (done, integruotas 11:09:23) `allowed-paths.ts`
`collectPathTokensFromLine` (92-105 eil.) bullet eilutėje (`^\s*[-*+]\s`) ima
TIK pirmą backtick tokeną, bet parseris vis dar eina PO VIENĄ EILUTĘ.
Etalono `## Failai` bullet'ai laužomi per kelias eilutes (pagrindimas
~78 simbolių pločiu — pats etalonas 63-64 eil. rodo tokį laužymą), o tęstinė
eilutė prasideda tarpais be bullet žymeklio, tad jai galioja sena taisyklė
„visi backtick tokenai = keliai". Skaitytojai teisingi, klaida įvestyje:
`src/application/quality-gates/preflight.ts:94` `allowedFiles =
allowedPaths(taskText)` → 154-155 eil. `context files N > max_files`;
`src/application/token-governance/tool-budget-gates.ts:121` skaičiuoja
`contextPack.allowed_paths.length` (iš `worker-task-ir.ts:142`
`parseAllowedPaths`) → 134 eil. tas pats tekstas → `budget_enforcement_failed`.

Operatorius 2026-09-02 abu failus pataisė rankomis — backtick'ai išimti iš
tęstinių eilučių (`AG/tasks/human-review/143-...md:56-59`: „pagrindime
backtick'ų nėra sąmoningai — parseris tęstinių eilučių tokenus skaičiuoja
kaip failus"; `116-...md:45-49` tas pats sakinys). Tai simptomo taisymas:
queue'je jau stovi ta pati forma — `152-...md:86-87` (Leidžiama, tęstinėje
`restoreFinishedSlots`), `152-...md:92-93` (Draudžiama, tęstinėje
`locateTask`), `120-...md:45-46` (tęstinėje `BiometricGateError`) — ir
kiekvienas jų kris ant to paties slenksčio be jokios realios apimties.

Sprendimo kryptis: bullet'as yra VIENAS loginis įrašas — bullet eilutė plius
visos iš karto po jos einančios tęstinės eilutės (prasideda bent vienu tarpu
ar tabu, nėra naujas bullet'as, nėra `Leidžiama:`/`Draudžiama:` žymeklis, nėra
tuščia). Kelias = PIRMAS backtick tokenas visame įraše; visi kiti backtick'ai
(bullet eilutėje ir tęstinėse) — pagrindimas. Įrašą nutraukia: tuščia eilutė,
naujas bullet'as, žymeklis, neįtraukta eilutė. Ne-bullet eilutės, kurios nėra
tęstinės (inline `Leidžiama: src/a.ts, src/b/**`, kelių backtick tokenų sąrašas
be bullet'o), lieka kaip dabar — `domain-tasks.test.ts:107-143` kontraktas
nesikeičia. Ta pati taisyklė `Draudžiama:` blokui — `forbiddenPaths` naudoja tą
patį surinkėją.

`backtickBareBullets` (`preflight-rules.ts:322-354`) PATIKRINTA: eina eilutė
po eilutės, perrašo TIK eilutes, atitinkančias `^(\s*[-*]\s+)(.*\S)\s*$` ir
be backtick'ų; tęstinė eilutė (be bullet žymeklio) į `bullet` regex'ą
nepataiko ir praleidžiama per `continue` (334-336 eil.) — struktūra nei
suliejama, nei skaidoma. Keisti nereikia; failas lygiai 500 eil., tad ir
negalima.

Atmesta alternatyva: filtruoti tokenus pagal formą („panašu į kelią") —
150 jau atmetė (`Dockerfile`/`Makefile` be `/` ir plėtinio yra tikros ribos;
`DeviationSeverity.ts` identifikatorius atrodytų kaip kelias). Antra
alternatyva — perrašyti etaloną „bullet'as vienoje eilutėje" — atmesta:
laužymas yra skaitomumo reikalavimas, ir pats etalonas jį demonstruoja.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/allowed-paths.ts` (189 eil.; bullet + tęstinės eilutės → vienas loginis įrašas, pirmas backtick tokenas)
- `src/tests/domain-tasks.test.ts` (190 eil.; laužyto bullet'o atvejai — žr. Veiksmas)
- `src/tests/scheduling-conflict-detector.test.ts` (253 eil.; 143 formos tekstas per computeTaskWriteSet duoda scope tik iš kelių, ne iš identifikatorių)

Draudžiama:
- `src/application/quality-gates/preflight-rules.ts` (backtickBareBullets
  nekinta — įrodymas Tiksle; failas lygiai 500 eil.)
- `src/tests/quality-gates-preflight.test.ts` (lygiai 500 eil.; normalizacija
  neliečiama, tad ir jos testai)
- `src/application/context-pack/worker-task-ir.ts` (parseBulletSection 342-372
  eil. sulanksto Veiksmas/Neįtraukta bullet'us ta pačia konvencija, bet gyvena
  application sluoksnyje — domain jos importuoti negali; žr. Neįtraukta)
- `src/application/quality-gates/preflight.ts` (skaičiuoja teisingai —
  klaida įvestyje; slenkstis nekeliamas)
- `src/application/token-governance/tool-budget-gates.ts` (tas pats)
- `src/domain/tasks/etalonas-rules.ts` (etalono taisyklės nekinta)
- `src/domain/tasks/size.ts` (isPathShapedToken lieka antru sargu dydžiui)
- `src/tests/fixtures/characterization/worker-task-ir.json` (turi tik
  vienaeilius bullet'us — pokytis reikštų, kad paliesta ne-laužyta forma)
- `src/tests/fixtures/characterization/task-sections.json` (tas pats)
- `AG/tasks/human-review/143-pack-semantics-descriptor-apima-visas-derinimo-konstantas.md`
  (operatoriaus pataisytas; nekeisti)
- `AG/tasks/human-review/116-pool-missing-lease-eilute-rodo-paskutine-provision-baigti.md`
  (tas pats)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `allowed-paths.ts`: `parseAllowedPaths` (119-121) ir `forbiddenPaths`
  (184-186) vietoje eilutė-po-eilutės ciklo kviečia bendrą bloko surinkėją
  (pvz. `collectPathTokensFromBlock(block, values)`), kuris eilutes
  sugrupuoja į loginius įrašus: bullet eilutė (`^\s*[-*+]\s`) atidaro įrašą;
  eilutė `^[ \t]+\S`, kuri nėra bullet'as ir nėra žymeklis
  (`ALLOW_MARKER`/`DENY_MARKER`), prijungiama prie atviro įrašo; tuščia eilutė,
  žymeklis, naujas bullet'as ar neįtraukta eilutė įrašą uždaro. Atviro įrašo
  nesant, įtraukta eilutė yra paprasta eilutė (esama logika).
- Įrašo vertė: PIRMAS backtick tokenas iš viso sujungto teksto; jei backtick'ų
  visame įraše nėra — esamas bare tokenų fallback taikomas TIK bullet eilutei
  (tęstinės eilutės be backtick'ų yra proza). Ne-bullet paprastoms eilutėms —
  esama `collectPathTokensFromLine` logika be pakeitimų.
- Atnaujinti 81-91 eil. komentarą: taisyklė „loginis įrašas = bullet +
  tęstinės eilutės" turi būti matoma iš kodo.
- Testų lūkestis (`domain-tasks.test.ts`, naujas `test(...)` šalia 123-143):
  (1) 143 formos bullet'as per tris eilutes su trimis backtick tokenais
  pagrindime (`` - `src/x/gather.ts` (TIK\n  `MIN_ARCHITECTURE_TOKEN_LENGTH` eksportas — dabar `const`;\n  žr. `SCORE_PRECISION`) ``) → `["src/x/gather.ts"]`;
  (2) du bullet'ai iš eilės, antras laužytas su backtick'u tęstinėje → du
  keliai, tik jie; (3) bullet'as + tęstinė eilutė, po jos iš karto
  `Draudžiama:` su savo laužytu bullet'u → `allowedPaths` vienas kelias,
  `forbiddenPaths` vienas kelias (tęstinės identifikatoriai nė vienoje pusėje);
  (4) inline forma `Leidžiama: src/a.ts, src/b/**` ir
  `` Leidžiama: `src/a.ts` `src/b.ts` `` — nepakitusios (abu keliai);
  (5) tuščia eilutė tarp bullet'o ir įtrauktos eilutės su backtick'u nutraukia
  tęstinumą — įtraukta eilutė tada yra paprasta eilutė ir jos backtick tokenas
  TAMPA keliu (esama ne-bullet taisyklė; įvardyta sąmoningai, kad reviewer'is
  matytų ribą); (6) laužytas bullet'as be jokių backtick'ų
  (`- src/plain.ts\n  pagrindimas su tokenu foo/bar.ts`) → tik `src/plain.ts`.
- `scheduling-conflict-detector.test.ts`: prie 43-53 regresijos pridėti 143
  formos tekstą → `entries.map(scope)` yra tik deklaruoti keliai (be
  `MIN_ARCHITECTURE_TOKEN_LENGTH` ir pan. entry), `gaps` be
  `unresolvable-scope`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei charakterizacijos
testai (`characterization-worker-task-ir.test.ts`,
`characterization-task-sections.test.ts`) ar `context-pack.test.ts` parausta —
jų fixture'ai turi tik vienaeilius bullet'us, tad raudona reikštų, kad
taisyklė paveikė ne-laužytą formą, ir tai yra operatoriaus sprendimas, ne
fixture'o perrašymas.

## Neįtraukta
- `backtickBareBullets` (`preflight-rules.ts`) keitimas — nereikalingas,
  įrodymas Tiksle; jei coder'is ras priešingą atvejį, tai atskiras task'as
  (failas lygiai 500 eil., reikės iškėlimo).
- `parseBulletSection` (`worker-task-ir.ts:342-372`) ir naujo domain
  sulankstymo suvienodinimas į vieną helper'į (`shared/markdown.ts` ar
  `domain/tasks`) — atskiras refaktoringas; čia domain gauna savo
  įgyvendinimą, nes application → domain importo kryptis draudžia
  perpanaudojimą. Reviewer'is dubliavimą pažymi, ne blokuoja.
- 143, 116, 152, 120 task failų perrašymas su backtick'ais tęstinėse
  eilutėse — po šio task'o forma leidžiama, bet grąžinti backtick'us ar ne
  sprendžia operatorius; 143/116 gyvena human-review ir liečiami tik jo.
- `max_files` slenksčio (8) kėlimas `tool-budget-gates`/`preflight` — ne;
  skaičius teisingas, kai įvestis teisinga.
- Etalono (`000-etalonas.md`) papildymas pastaba apie laužytus bullet'us —
  po šio task'o nebūtina; etalono keitimams reikia atskiro operatoriaus
  pavedimo.
- `size.ts` `isPathShapedToken` — nekinta (identifikatoriai be `/`, `.`, `*`
  ten ir šiandien atfiltruojami, tad dydžio skaičiavimas šios klaidos nematė).
