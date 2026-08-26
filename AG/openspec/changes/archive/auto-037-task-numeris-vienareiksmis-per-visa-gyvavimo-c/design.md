# Design

## Approach

**(1) Numerio↔šeimos vartas.** Nauja pure domain/application funkcija sudaro žemėlapį `šaknies numeris → task šeimų sąrašas` iš visų `AG/tasks/*` bucket'ų failų vardų: kiekvienam failui ištraukiamas šaknies numeris (`taskNumberFromFilename` arba pirmas skaičius prefiksas split-vaiko atveju per `splitChildParentStemCandidates`/šeimos bazę), o šeimos tapatybė — pati bazė (numeris arba split-child šeimos bazė, žr. `enqueue-child-tasks.ts` `parentTaskFamily`). Jei tam pačiam numeriui priskiriamos DVI ar daugiau skirtingų NE-šeimos (t. y. failai, kurių bazė sutampa, bet jie nėra vieno tėvo/vaiko grandinės dalis), tai yra kolizija. Testas šį žemėlapį sulygina su statiniu KNOWN sąrašu (numeris + abiejų šalių pavyzdinis failo vardas + trumpa priežastis, pvz. "029: du nesusiję task'ai skirtingose kūrimo linijose, žr. audit 2026-08-26"). Nauja kolizija, kurios nėra KNOWN sąraše → testas raudonas. KNOWN įrašas, kurio kolizija realiai jau nebeegzistuoja diske → testas TAIP PAT raudonas (reikalauja pašalinti pasenusį leidimą) — abi kryptys tikrinamos tuo pačiu testu.

**(2) Parametrizuotas `taskWorkEvidenceGrepArgs`.** Funkcijos signatūra pratęsiama antru parametru, pvz. `taskWorkEvidenceGrepArgs(taskId: string, numberIsUnique: boolean)`. Sprendimą, ar numeris unikalus, skaičiuoja application sluoksnio kvietėjas (tas pats, kuris jau turi prieigą prie `AG/tasks/*` per fs portą — analogiškai `nextAvailableTaskNumber`), naudodamas tą PAČIĄ (1) punkte aprašytą pure funkciją numerio unikalumui patikrinti. `taskEvidenceRangeArgs`/`evidenceCandidates`/`windowProductWorkSha` niekas nesikeičia — keičiasi tik `taskCommittedProductWorkSha`/`taskCommittedWorkSha` kvietimo grandinė, kad `numberIsUnique` reikšmę gautų iš `WorkEvidenceInput` (naujas laukas) ir perduotų toliau. Split-child atvejis (`isSplitChildTaskId`) lieka nepakitęs — jam plikieji šablonai jau ir šiandien nededami; naujas parametras tiesiog papildo TĄ PAČIĄ sąlygą (`isSplitChildTaskId(taskId) || !numberIsUnique` → tik pilnas id).

**(3) Skyrimo lenktynių retry.** `taskGenerate` (generate.ts:92-104 kilpoje) prieš PIRMĄ `writeFileExclusive` kvietimą kiekvienam `startIndex` kandidatui iš naujo perskaito bucket'us (`nextAvailableTaskNumber` logika, bet tik patikrinimui — ar `startIndex..startIndex+taskLines.length-1` diapazonas vis dar laisvas). Jei kuris nors numeris tame diapazone jau užimtas kito failo (lygiagreti sesija), visas `startIndex` perskaičiuojamas (+1 nuo naujo realaus maksimumo) ir patikra kartojama. Ribotas bandymų skaičius (pvz. 5), viršijus — `Error` su aiškiu pranešimu (numeris, bandymų skaičius). `writeFileExclusive` `wx` semantika jau apsaugo nuo failo PERRAŠYMO, bet NE nuo to, kad du skirtingi task'ai (skirtingi slug'ai) gautų tą patį numerį skirtinguose failuose — būtent tą papildomą atvejį uždaro (3).

**(4) Dokumentacija.** Vienos pastraipos papildymas `enqueue-child-tasks.ts` galvutės komentare, be jokio elgesio pakeitimo.

## Data Flow

```
AG/tasks/{queue,active,delegated,error,failed,human-review,done}/*.md
            │ (failų vardai, jau skaitomi application sluoksnyje)
            ▼
[domain] numerio→šeimos žemėlapio funkcija (pure, be IO)
            │
   ┌────────┴─────────────────────────┐
   ▼                                   ▼
[tests] KNOWN kolizijų sąrašo      [application] numberIsUnique(taskId)
  sulyginimas (vartas #1)           kvietėjas prieš work-evidence kvietimą
                                          │
                                          ▼
                              [infrastructure] taskWorkEvidenceGrepArgs(
                                 taskId, numberIsUnique)  ← parametras, NE fs skaitymas
```

`taskGenerate` retry kilpa (3) naudoja tą pačią `taskBuckets`/`taskNumberFromFilename` prieigą, kurią jau turi `nextAvailableTaskNumber` — jokio naujo IO kontrakto, tik pakartotas kvietimas.

## Risks

- **KNOWN sąrašo entropija**: jei testas leidžia laisvą tekstinį aprašą be struktūrinio patikrinimo prieš diską, jis gali "sugesti į tylą" (leisti bet ką). Mažinama: testas privalo tikrinti abi kryptis (žr. Approach 1) — pasenęs KNOWN įrašas yra raudonas testas, ne praleistas.
- **Byte-for-byte reikalavimas (2)**: bet koks netikslumas `numberIsUnique` skaičiavime unikaliam numeriui grąžintų kitokį grep rinkinį nei šiandien — tai tyliai PRARADO jau veikiančius įrodymus. Mažinama: testas su fiktyviu unikaliu numeriu turi patvirtinti identišką masyvą kaip esamas `taskWorkEvidenceGrepArgs(taskId)` be parametro.
- **Retry kilpos (3) begalybė**: teoriškai lygiagreti sesija galėtų nuolat "laimėti" lenktynes. Ribojama fiksuotu bandymų skaičiumi su aiškia klaida — tai jau yra didesnė lygiagrečios rašymo saugos problema, kurios šis change'as nesprendžia iki galo, tik nebeleidžia jai pasireikšti kaip TYLIAI PRARASTAI kolizijai.
- **Sluoksnių riba (2)**: jei `numberIsUnique` skaičiavimas pareikalautų infrastruktūroje skaityti `AG/tasks/*` diską, tai pažeistų `infrastructure → application` žinojimo kryptį šiame kontekste (work-evidence gauna sprendimą, ne duomenis). Jei paaiškėtų, kad parametro perdavimas per visą kvietimo grandinę (WorkEvidenceInput → taskCommittedProductWorkSha → taskWorkEvidenceGrepArgs) yra nepatogus, tai signalas STABDYTI ir klausti, ne apeiti sluoksnio ribą infrastruktūroje.
