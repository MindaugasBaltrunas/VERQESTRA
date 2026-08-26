# Proposal

## Why

Audito 2026-08-26 radinys: `AG/tasks/done` + `AG/tasks/queue` šiandien turi bent keturias šaknies numerio kolizijas (029, 030, 031, 032), kur du visiškai nesusiję task'ai gyveno arba gyvena po tuo pačiu numeriu skirtingose lygiagrečiose kūrimo linijose. Tuo pat metu `src/infrastructure/git/work-evidence.ts:48-62` (`taskWorkEvidenceGrepArgs`) ne-split-vaiko task'ui prideda du papildomus plikus šablonus (`\(NNN\)`, `task NNN($|[^0-9-])`) šalia pilno id grep'o. Šie šablonai neskiria "mano" numerio nuo "kito task'o su tuo pačiu numeriu" — jei du numeruoti task'ai su tuo pačiu šaknies numeriu yra gyvi vienu metu (arba jų gyvavimo langai persidengia), vieno darbo commit'as gali užskaityti kito task'o įrodymą. Intervalo sargas (`base_head..HEAD`, `taskEvidenceRangeArgs`) šios spragos neuždaro: jis apriboja LAIKĄ, o ne AUTORIŲ — svetimo task'o commit'as, padarytas per persidengusį langą, patenka į intervalą lygiai taip pat kaip savas.

Rizika yra ta pati, kurią `work-evidence.ts` galvutės komentaras jau įvardija kaip asimetrišką: melagingas įrodymas uždaro niekada neįgyvendintą task'ą IR atrakina jo priklausinius. Numerio dviprasmybė šią klaidos rūšį daro sisteminę, ne pavienę.

## Scope

1. **Vartas (naujas testas)**: per visus `AG/tasks/*` bucket'us (`queue`, `active`, `delegated`, `error`, `failed`, `human-review`, `done`) patikrina, kad kiekvienas šaknies numeris žymi VIENĄ task šeimą (split vaikai priskiriami tėvo šeimai per `splitChildParentStemCandidates`/šeimos bazę). Keturios šiandien žinomos istorinės kolizijos (029, 030, 031, 032) įtraukiamos į eksplicitinį KNOWN sąrašą su priežastimi — testas jų neblokuoja, bet blokuoja BET KOKIĄ NAUJĄ koliziją. KNOWN sąrašas prikaltas iš abiejų pusių: jei kolizija dingsta iš disko (task'as pervadintas/užbaigtas ir suvienodintas), testas privalo REIKALAUTI pašalinti tą KNOWN įrašą (nebenaudojamas leidimas = klaida).
2. **Griežtėjantys įrodymai**: `taskWorkEvidenceGrepArgs` gauna papildomą parametrą, sakantį, ar šio task'o numeris ŠIUO METU yra unikalus tarp visų bucket'ų. Kai numeris dviprasmiškas, funkcija elgiasi kaip su split-child (TIK pilno id grep'as) — plikieji `\(NNN\)` / `task NNN` šablonai praleidžiami. Kai numeris unikalus, elgesys lieka byte-for-byte identiškas dabartiniam. Žinojimą apie unikalumą skaičiuoja KVIETĖJAS (application sluoksnis), infrastruktūra fs neskaito.
3. **Skyrimo lenktynių apsauga**: `taskGenerate` (`src/application/task-planning/generate.ts`) po `nextAvailableTaskNumber` parinkimo ir PRIEŠ pirmo failo rašymą pertikrina, ar joks kitas bucket'o failas per tą laiką nepradėjo tuo pačiu numeriu (lygiagreti sesija galėjo įrašyti failą tarp skaitymo ir rašymo). Radus koliziją — numeris +1, patikra kartojama su ribotu bandymų skaičiumi; viršijus limitą — klaida, ne tylus persidengimas.
4. **Dokumentacija**: `enqueue-child-tasks.ts` šeimos bazės komentaro blokas (~eilutės 20-36) papildomas viena pastraipa, nurodančia, kad bazės (šaknies numerio) vienareikšmiškumą nuo šiol garantuoja (1) vartas, ne vien konvencija.

## Out Of Scope

- Esamų `AG/tasks/**` failų pervadinimas, perkėlimas ar istorijos taisymas — KNOWN kolizijos lieka diske tokios, kokios yra.
- `github/issue-import.ts` numeracijos taisyklės (GitHub issue numeris ateina iš išorės, ne iš šio generatoriaus).
- 036 shadow matavimų darbas.
- Bet koks jau GYVO task'o statuso keitimas — jei paaiškėtų, kad koks nors gyvas task'as jau užsidarė ant svetimo numerio commit'o, tai yra atskiras operatoriaus sprendimas, ne šio change'o dalis.

## Architecture Boundaries

- **Paliečiami moduliai**: `src/infrastructure/git/work-evidence.ts` (infrastructure), `src/application/task-planning/**` (application), `src/application/task-execution/enqueue-child-tasks.ts` (application, tik komentaras), `src/domain/tasks/**` (domain, jei reikia naujos pure funkcijos numerio→šeimos žemėlapiui sudaryti), `src/tests/**`.
- **Sluoksnių kryptis**: infrastructure → application/domain/shared (galioja); jokio naujo infrastructure → domain skaitymo iš disko apie kitus bucket'us — tas žinojimas lieka application sluoksnyje ir keliauja į infrastruktūros funkciją kaip paprastas parametras (funkcijos signatūra, ne fs prieiga).
- **DB**: nėra. Reads: `AG/tasks/{queue,active,delegated,error,failed,human-review,done}/*.md` failų vardai (jau ir dabar skaitomi `nextAvailableTaskNumber`/testų). Writes: naujas queue task failas (nesikeičia esama semantika), jokių naujų write vietų.
- **Job types**: nėra (ne job-queue infrastruktūra; tai task-planning/evidence use-case'ai).
