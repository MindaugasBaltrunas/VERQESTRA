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

HUMAN-REVIEW-APPROVED: operatorius 2026-09-02 „aš visus tasks approve" (dependency vartai: mobile-gateway/package.json scripts)

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `mobile-gateway/package.json` scripts turi `start` (ar `bin` įrašą), o
`mobile-gateway/src/composition/` (ar kitas kompozicijos modulis) komponuoja
host-bootstrap + certificate source + gateway listener + remote router +
websocket gateway + local-control listener į paleidžiamą main() —
ALREADY_IMPLEMENTED: cituok script'ą ir kompozicijos modulio surišimo kodą
kaip įrodymą.

## Tikslas
Mobile audito P0 (2026-09-01): gateway NETURI vykdomo entry point — visa
mechanika yra, bet niekas jos nesukomponuoja. Patikrinta:
`mobile-gateway/package.json:9-13` — tik `build`/`typecheck`/`test`, jokio
`start`/`bin`; `src/index.ts` — grynas barrel be main();
`createNodeGatewayListener` (`node-gateway-listener.ts:28`) produkcinio
kvietėjo neturi (Grep: tik `src/tests/node-gateway-listener.test.ts`);
`host-bootstrap.ts` (bind policy rfc1918/CGNAT/ULA, „no degraded mode"
kontraktas) ir `tls-gateway-server.ts` (`createGatewayTlsServer`,
`createGatewayRequestListener`) taip pat be produkcinio kvietėjo. Visi 893
mobile testai žali, nes testuoja dalis — kompozicijos šaknies tiesiog nėra.
Kartu pasenusi dokumentacija: `doc/verification-matrix.md:230` teigia „the
gateway has no remote listener until certificate binding and private-network
policy land" — abu jau kode (`file-host-certificate-source.ts`,
`bind-address-policy.ts`), trūko tik entry. Sprendimas: kompozicijos šaknis
(`src/composition/`), kuri suriša host-bootstrap + failinį cert šaltinį +
`createNodeGatewayListener` + remote-gateway-router + terminal websocket
gateway + local-control listener, ir `start` script'as jai paleisti. ŠIS
TASK'AS AIŠKIAI APIMA `mobile-gateway/package.json` scripts keitimą (be
naujų dependencies).

## Agentai
readme-guard -> architect -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `mobile-gateway/package.json` (TIK scripts blokas — `start`; dependencies
  nekeičiamos)
- `mobile-gateway/src/composition/gateway-main.ts` (numatomas naujas; jei
  paketo konvencija pareikalautų kito kelio/vardo — tas failas vietoje šio,
  įrašyti į ataskaitą)
- `mobile-gateway/src/tests/gateway-main.test.ts` (numatomas naujas)
- `mobile-gateway/doc/verification-matrix.md` (TIK 230 eil. frazės korekcija
  — „no remote listener" nebetiesa, blokuoja tik native adapteriai ir
  hardware)

Draudžiama:
- `mobile-gateway/src/index.ts` (barrel'io viešas paviršius nekinta — jo
  komentaras 45-49 eil. sąmoningai neeksportuoja local-control; kompozicija
  importuoja tiesioginiais keliais)
- `mobile-gateway/src/application/**` ir `src/interfaces/**` (mechanika
  teisinga — tik komponuojama, nekeičiama)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `src/composition/gateway-main.ts`: main(), kuris (1) sukuria failinį cert
  šaltinį ir host network interface adapterį; (2) per host-bootstrap
  kontraktą (bind policy, be degraded mode — jo doc 22-30 eil.) pakelia TLS
  serverį (`createGatewayTlsServer` + `createGatewayRequestListener` +
  `createNodeGatewayListener`); (3) prijungia terminal websocket gateway ir
  local-control listener; (4) klaidas paverčia aiškiu `not_configured`
  pranešimu su priežastimi, ne stack trace. Konfigūracijos šaltinį (portai,
  cert keliai) pasirenka vykdytojas pagal esamą `gateway-data-directory.ts`
  konvenciją ir pagrindžia ataskaitoje.
- `package.json` scripts: `"start": "node dist/composition/gateway-main.js"`
  (ar ekvivalentas po build).
- Testų lūkestis (`gateway-main.test.ts`): kompozicija su test double'ais
  suriša visus sluoksnius — (1) pilna konfigūracija → listener pakyla;
  (2) trūkstamas cert → `not_configured` su priežastimi, jokio plain HTTP
  fallback; (3) start script'as rodo į realų kompiliuotą failą.
- PATIKROS PASTABA: mobile paketai į šaknies `pnpm test` neįtraukti
  (CLAUDE.md sąmoningas sprendimas), o `## Patikra` vartas leidžia tik
  šaknines formas — todėl vykdytojas PRIVALO papildomai paleisti
  `pnpm test:mobile` (šakninis script'as; `pnpm --dir ...` formas blokuoja
  bash hook'ai) ir rezultatą įrašyti į ataskaitą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios ir `pnpm test:mobile` žalias. Stop ir klausk,
jei kompozicijai prireiktų NAUJOS dependency (pvz. CLI arg parserio) —
dependency keitimas šio task'o apimtyje nėra.

## Neįtraukta
- Naujos dependencies — kompozicija renkasi tik iš esamų (`ws`, `node-pty`,
  node built-ins).
- Native shell kompozicija — task 118.
- `verification-matrix.md` hardware žingsnių turinys — keičiama tik pasenusi
  „no remote listener" frazė.
