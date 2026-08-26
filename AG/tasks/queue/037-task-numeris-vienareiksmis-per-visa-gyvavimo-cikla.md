# Task

## Spec source
docs/audits/ (numeracijos kolizijų auditas 2026-08-26)
src/infrastructure/git/work-evidence.ts (įrodymų grep semantika)
src/application/task-planning/generate.ts (DUP-14 skyrimo taisyklė)

## Tikslas
Task'o numeris privalo būti vienareikšmis per visą gyvavimo ciklą, o kur jis
vienareikšmis nėra — juo negalima remtis. Auditas 2026-08-26: numeriai 029–032 turi po
DU nesusijusius task'us (lygiagrečios kūrimo linijos), o `work-evidence` numeruotam
task'ui commit'us atpažįsta ir plikais šablonais `\(NNN\)` / `task NNN` — dviem
lygiagrečiai gyviems to paties numerio task'ams vienas gali užsidaryti ant KITO darbo.
Intervalo sargas (`base_head..HEAD`) nuo to nesaugo: svetimas commit'as krenta į
intervalą, kai gyvenimai persidengia.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/work-evidence.ts`
- `src/application/task-planning/**`
- `src/application/task-execution/enqueue-child-tasks.ts`
- `src/domain/tasks/**`
- `src/tests/**`

Draudžiama:
- `AG/tasks/**` (esamų task failų NEpervadinti — istorija ir įrodymų nuorodos šventos)
- `vq/**`
- `.env`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAS: `work-evidence.ts:48-62` ne-split numeruotam task'ui prideda grep'us
  `\(NNN\)` ir `task NNN($|[^0-9-])` šalia pilno id. FAKTAS: `AG/tasks/done` +
  `AG/tasks/queue` šiandien turi 029/030/031/032 po du kartus (pvz.
  `029-http-riba-...` ir `029-prompt-nesa-taska-...`).
- (1) VARTAS: naujas testas, kuris per visus `AG/tasks/*` bucket'us tikrina, kad
  vienas šaknies numeris priklauso vienai task šeimai (split vaikai — tos pačios
  šeimos nariai). Esamos 4 istorinės kolizijos įrašomos į aiškų KNOWN sąrašą su
  priežastimi (nepervadinamos); NAUJŲ kolizijų testas neleidžia. Abi kryptys
  prikaltos: pašalinus koliziją iš disko, KNOWN įrašas privalo būti išimtas.
- (2) ĮRODYMAI GRIEŽTĖJA, kai numeris dviprasmis: `taskWorkEvidenceGrepArgs`
  gauna žinojimą (per parametrą iš kvietėjo, ne per fs skaitymą infrastruktūroje),
  ar task'o numeris šiuo metu unikalus tarp bucket'ų. Dviprasmiam numeriui lieka TIK
  pilno id grep'as — kaip split vaikams dabar. Unikaliam — elgesys nesikeičia
  byte-for-byte. Kryptis tik griežtinanti: joks commit'as, kuris šiandien
  NEužskaitomas, netampa užskaitomu.
- (3) SKYRIMO LENKTYNĖS: `taskGenerate` po numerio parinkimo ir PRIEŠ rašymą
  pertikrina, ar joks kitas bucket'o failas nepradeda tuo pačiu numeriu; radus —
  numeris +1 ir kartojama (ribotas bandymų skaičius, tada klaida). Rankinei kūrybai
  vartas (1) yra saugiklis — atskiro CLI nereikia.
- Dokumentuoti `enqueue-child-tasks.ts` šeimos bazės komentare: bazės
  vienareikšmiškumą nuo šiol garantuoja vartas (1).

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei (2) įgyvendinimas reikalautų infrastructure
sluoksnyje skaityti task bucket'us (sluoksnių riba: žinojimą paduoda application
kvietėjas) arba jei paaiškėtų, kad kuris nors GYVAS task'as jau užsidarė ant svetimo
numerio commit'o — tada pirma reikia operatoriaus sprendimo dėl to task'o statuso.

## Neįtraukta
- Esamų failų pervadinimas ar istorijos taisymas.
- `github/issue-import.ts` numeracija (GitHub issue numeris ateina iš išorės).
- 036 shadow matavimai.
