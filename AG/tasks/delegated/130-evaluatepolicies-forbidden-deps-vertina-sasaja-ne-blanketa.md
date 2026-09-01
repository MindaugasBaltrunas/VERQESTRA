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
Jei `src/domain/architecture/node-verification-rules.ts` `evaluatePolicies`
(dabar 134-158 eil.) `forbidden_dependencies` įrašus vertina pagal SĄSAJĄ su
mazgu (pvz. per `detectForbiddenDependencyViolations` ar ekvivalentišką
gradavimą), o ne žymi kiekvieną įrašą kiekvienam mazgui —
ALREADY_IMPLEMENTED: cituok vertinimo kodą, perrašytą testą ir nukrypimo
įrašą `migration-coverage.json` kaip įrodymą.

## Tikslas
Audito P3, dormant divergencija su garantuotu sprogimu įjungus: patikrinta
`node-verification-rules.ts:149-155` — ciklas per
`architectureStyle.forbidden_dependencies` KIEKVIENĄ įrašą deda į
`policy_blockers` (strictness=block) ar `policy_warnings` KIEKVIENAM mazgui,
visiškai netikrindamas, ar mazgas su ta priklausomybe apskritai susijęs.
Teisinga graduota versija egzistuoja GRETA:
`domain/policies/architecture-style.ts:124`
`detectForbiddenDependencyViolations` — vertina endpoint'ų sąsają su failais
ir code-graph briaunomis. Paties modulio docstring'as (120-133 eil.)
argumentuoja prieš euristikas be objektyvaus signalo — o blanket'as yra dar
blogiau už euristiką: nulis signalo. Dormant šiandien:
`vq/architecture/architecture-style.json` nėra → default advisory/[] —
bet operatoriui sukūrus block-mode konfigą su bent vienu įrašu, NĖ VIENAS
mazgas nepasiektų done (`application/architecture/node-verifier.ts:129`
kvietimas). SVARBU — TAI SĄMONINGAS NUKRYPIMAS NUO ETALONO: elgesys yra 1:1
etalono portas, pin'intas `src/tests/domain-vq204.test.ts:245-258`.
Todėl task'as PRIVALO: (1) elgesį pakeisti Į griežtinančią pusę (blokas tik
su realia sąsaja — klaidingi blokai nustoja egzistuoti, realūs lieka);
(2) testą PERRAŠYTI pagal naują elgesį su pagrindimu (tai elgesio keitimas,
ne testo silpninimas — naujas testas tvirtina sąsajos vertinimą);
(3) nukrypimą įrašyti į `migration-coverage.json` ir commit ataskaitą, o
etalono `tasks.md` anotaciją palikti operatoriui/commit žingsniui pagal
CLAUDE.md „Nukrypimai nuo etalono" taisyklę.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/architecture/node-verification-rules.ts`
- `src/application/architecture/node-verifier.ts` (tik jei `evaluatePolicies`
  signatūrai reikia mazgo sąsajos konteksto — kvietėjas paduoda
  `implemented_files` ar pan.)
- `src/tests/domain-vq204.test.ts` (245-258 eil. pin'o perrašymas su
  pagrindimu)
- `migration-coverage.json` (nukrypimo įrašas su priežastimi)

Draudžiama:
- `src/domain/policies/architecture-style.ts`
  (`detectForbiddenDependencyViolations` teisinga — naudojama ar
  atkartojama jos logika, pati nekeičiama)
- `src/tests/context-pack-guards.test.ts` ir kiti preflight vartotojų
  testai (preflight kelias jau graduotas — nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `node-verification-rules.ts` (`evaluatePolicies` 149-155 eil.):
  `forbidden_dependencies` vertinimas pagal mazgo sąsają — endpoint'ų
  palyginimas su `nodeProgress.implemented_files` (per
  `detectForbiddenDependencyViolations` importą iš domain/policies arba
  bendrą jos vidinę taisyklę — kopijos nekurti, docstring 40-45 eil. RAG
  audito pamoka apie tyliai išsiskiriančias kopijas); įrašas be sąsajos su
  mazgu negeneruoja NIEKO tam mazgui; su sąsaja — blocker/warning pagal
  strictness kaip dabar.
- `domain-vq204.test.ts`: pin'as perrašomas — (1) mazgas, kurio
  `implemented_files` liečia forbidden endpoint'ą → blocker (block-mode);
  (2) mazgas be sąsajos → NEI blocker, NEI warning; (3) warn-mode sąsajos
  atvejis → warning; komentaras teste įvardija nukrypimą ir jo priežastį.
- `migration-coverage.json`: nukrypimo įrašas (griežtinantis, priežastis —
  blanket blokeris padarytų block-mode nenaudojamą); commit ataskaitoje —
  tas pats; etalono `tasks.md` anotacija — įrašyti į ataskaitą kaip likusį
  žingsnį (etalono failas už šio repo ribų).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei sąsajos vertinimui
reikalingų duomenų (pvz. mazgo import briaunų) `evaluatePolicies` kvietėjo
kontekste apskritai nėra ir jų pridėjimas keistų daugiau kvietėjų nei
`node-verifier.ts` — tada apimtis persvarstoma.

## Neįtraukta
- `codingPrinciples` neskaitymo sprendimas (PC-CODING-01, docstring
  125-132) — sąmoningas, nekvestionuojamas.
- `architecture-style.json` konfigo sukūrimas ar block-mode įjungimas —
  operatoriaus sprendimas; šis task'as tik padaro jį įmanomą.
- Preflight kelio (`detectForbiddenDependencyViolations` vartotojų)
  keitimai — jie jau teisingi.
