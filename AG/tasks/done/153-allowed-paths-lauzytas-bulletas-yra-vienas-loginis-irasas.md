# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 150-allowed-paths-ima-tik-pirma-backtick-tokena-leidziama-bullete (done)

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/tasks/allowed-paths.ts` `parseAllowedPaths` (119-121 eil.) ir `forbiddenPaths` (184-186 eil.) jau NEskaito bloko po vieną eilutę, o sulanksto bullet eilutę su po jos einančiomis įtrauktomis tęstinėmis eilutėmis į vieną loginį įrašą, ir `src/tests/domain-tasks.test.ts` turi atvejį, kur backtick tokenas tęstinėje eilutėje NEtampa keliu — atsakyk ALREADY_IMPLEMENTED ir cituok sulankstymo funkciją bei testą. Nieko nekeisk.

## Tikslas
Etalono `## Failai` bullet'ai laužomi per kelias eilutes, o pagrindimas tęstinėje eilutėje turi backtick'us (pvz. `` MIN_ARCHITECTURE_TOKEN_LENGTH` eksportas ``). Tęstinė eilutė neturi bullet žymeklio, tad patenka į ne-bullet šaką ir visi jos backtick tokenai virsta „keliais". Dėl to 2026-09-02 task'ai 116 ir 143 krito `budget_enforcement_failed=context files 10 > 8` ir `12 > 8`, nors realiai turėjo 6 ir 5 kelius.

Sprendimas: bullet'as = VIENAS loginis įrašas (bullet eilutė + iš karto po jos einančios tęstinės eilutės), iš kurio imamas TIK pirmas backtick tokenas. Įrašą nutraukia tuščia eilutė, naujas bullet'as, `Leidžiama:`/`Draudžiama:` žymeklis arba neįtraukta (be pradinio tarpo) eilutė. Ne-bullet inline forma (`Leidžiama: src/a.ts, src/b/**`, kelių backtick tokenų sąrašas be bullet'o) elgiasi kaip dabar — `src/tests/domain-tasks.test.ts:107-143` kontraktas nesikeičia. Ta pati taisyklė galioja `Draudžiama:` blokui, nes `forbiddenPaths` naudoja tą patį surinkėją.

## Agentai
Privaloma grandinė: readme-guard -> debugger -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/domain/tasks/allowed-paths.ts`
- `src/tests/domain-tasks.test.ts`

Draudžiama:
- `src/application/quality-gates/preflight-rules.ts`
- `src/application/quality-gates/preflight.ts`
- `src/application/token-governance/tool-budget-gates.ts`
- `src/application/context-pack/worker-task-ir.ts`
- `src/domain/tasks/etalonas-rules.ts`
- `src/domain/tasks/size.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `src/domain/tasks/allowed-paths.ts`: pridėk bloko sulankstymo funkciją, kuri eilučių sąrašą paverčia loginiais įrašais (bullet + tęstinės įtrauktos eilutės), ir naudok ją abiejose vietose — `parseAllowedPaths` (119-121 eil.) ir `forbiddenPaths` (184-186 eil.); `collectPathTokensFromLine` bullet taisyklė lieka ta pati, tik dabar mato visą įrašą.
- Atnaujink JSDoc'ą, kad paaiškintų loginį įrašą ir jo nutraukimo sąlygas; failas privalo likti ≤500 eil., be jokio `node:` importo (domain sluoksnis).
- `src/tests/domain-tasks.test.ts`: pridėk atvejus — (1) laužytas `Leidžiama:` bullet'as su backtick tokenu tęstinėje eilutėje duoda TIK vieną kelią; (2) tas pats `Draudžiama:` bloke; (3) esama inline ne-bullet forma (107-143 eil.) nepakitusi.

## Patikra
- `pnpm test`

## Stop
Sustok ir klausk, jei: pataisa reikalautų keisti bet kurį `Draudžiama:` failą; `allowed-paths.ts` viršytų 500 eilučių; kristų esami `domain-tasks.test.ts` ar preflight testai ir vienintelis kelias juos pataisyti būtų susilpninti tvirtinimą. Neweakink testų, kad vartai pažaliuotų.

Kai `pnpm test` žalias — commit'ink pakeitimą ir baik. Neimk kitų šio task'o dalių.

## Neįtraukta
- `src/tests/scheduling-conflict-detector.test.ts` regresija (143 formos tekstas per `computeTaskWriteSet`) — atskiras sekantis vaikas.
- Queue failų 152/120 teksto taisymas ranka — simptomo taisymas, nedaromas.
- `worker-task-ir.ts` `parseBulletSection` suvienodinimas su domain surinkėju — application sluoksnis, atskira užduotis.
