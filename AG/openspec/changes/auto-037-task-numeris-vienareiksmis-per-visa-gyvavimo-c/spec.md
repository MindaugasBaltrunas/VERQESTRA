# Spec Delta

## Added

- Domain/application pure funkcija, sudaranti `šaknies numeris → task šeimų sąrašas` žemėlapį iš `AG/tasks/*` bucket'ų failų vardų (split vaikai priskiriami tėvo šeimai).
- Naujas testas `src/tests/task-number-uniqueness.test.ts` (arba analogiškas pavadinimas atitinkantis projekto konvenciją), kuris:
  - patikrina, kad kiekvienas šaknies numeris `AG/tasks/*` žymi vieną task šeimą, IŠSKYRUS eksplicitinį KNOWN kolizijų sąrašą (numeris + abi pusės + priežastis);
  - reikalauja, kad KIEKVIENAS KNOWN įrašas atitiktų REALIAI diske esančią koliziją (pasenęs įrašas → testas raudonas);
  - reikalauja, kad JOKIA nauja (ne-KNOWN) kolizija neatsirastų.
- Naujas parametras `numberIsUnique: boolean` funkcijai `taskWorkEvidenceGrepArgs` (`src/infrastructure/git/work-evidence.ts`), reguliuojantis, ar pridėti plikuosius `\(NNN\)` / `task NNN($|[^0-9-])` šablonus.
- Naujas (arba papildytas) laukas `WorkEvidenceInput` tipe, nešantis `numberIsUnique` reikšmę iš kvietėjo į `taskCommittedProductWorkSha`/`taskCommittedWorkSha`.
- Skyrimo lenktynių patikra `taskGenerate` funkcijoje (`src/application/task-planning/generate.ts`): pertikrinimas prieš rašymą + ribotas retry su numerio +1 žingsniu ir klaida viršijus bandymų limitą.
- Viena pastraipa `enqueue-child-tasks.ts` galvutės komentare, nurodanti, kad bazės vienareikšmiškumą garantuoja naujas testų vartas.

## Changed

- `taskWorkEvidenceGrepArgs(taskId: string)` → `taskWorkEvidenceGrepArgs(taskId: string, numberIsUnique: boolean)`. Elgesys UNIKALIAM numeriui (`numberIsUnique === true`) lieka byte-for-byte identiškas dabartiniam. Elgesys DVIPRASMIŠKAM numeriui (`numberIsUnique === false`) susiaurėja iki pilno id grep'o (kaip split-child šiandien) — griežtėjanti, ne laisvėjanti kryptis.
- Visi šios funkcijos kvietėjai (`taskCommittedProductWorkSha`, `taskCommittedWorkSha`) atnaujinami perduoti `numberIsUnique` iš `WorkEvidenceInput`.
- `taskGenerate` numerio parinkimo žingsnis (`generate.ts:92-104`) papildomas pertikrinimu prieš pirmą rašymą ir riboto bandymų skaičiaus retry logika.

## Acceptance Criteria

1. Naujas testas RAUDONAS, jei bet kuris `AG/tasks/*` šaknies numeris žymi ≥2 nesusijusias šeimas ir ta kolizija NĖRA KNOWN sąraše.
2. Naujas testas RAUDONAS, jei KNOWN sąraše yra įrašas, kurio kolizijos šiuo metu diske NĖRA (t. y. įrašas pasenęs ir turi būti pašalintas).
3. Naujas testas ŽALIAS su šiandienine `AG/tasks/*` būsena, kai KNOWN sąraše yra lygiai tie įrašai, kurie realiai atitinka 029/030/031/032 (arba tiek, kiek jų realiai patvirtinama audito metu).
4. `taskWorkEvidenceGrepArgs(taskId, true)` grąžina IDENTIŠKĄ masyvą kaip esamas `taskWorkEvidenceGrepArgs(taskId)` (be parametro) kiekvienam ne-split-child taskId — patvirtinta testu prieš/po refaktoringo.
5. `taskWorkEvidenceGrepArgs(taskId, false)` ne-split-child taskId grąžina TIK `--extended-regexp --regexp-ignore-case --grep=<pilnas id>` (be `\(NNN\)`/`task NNN` šablonų).
6. Split-child taskId elgesys nepakitęs jokiu `numberIsUnique` reikšmės deriniu (visada tik pilnas id).
7. `taskGenerate`, paleistas su dviem lygiagrečiais kvietimais (arba testu, kuris simuliuoja kito bucket'o failo atsiradimą tarp numerio parinkimo ir rašymo), negeneruoja dviejų skirtingų task'ų su tuo pačiu šaknies numeriu; viršijus bandymų limitą, meta aiškią klaidą.
8. `enqueue-child-tasks.ts` komentaras atnaujintas; jokio elgesio pakeitimo tame faile.
9. `pnpm typecheck && pnpm test` žali (lint → build → testai, įskaitant `architecture-gates.test.ts`).
