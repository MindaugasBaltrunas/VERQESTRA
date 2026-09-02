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

## Tikslas
Native kiautas siandien registruoja App be jokiu portu. Pirmas zingsnis: native kompozicijos
modulis, kuris pastato platformos transportus be nauju dependencies - RN `fetch` i
MobileHttpTransportPort ir RN `WebSocket` i MobileWebSocketFactory - ir is ju GatewayHttpClient
bei TerminalStreamClient. Sie objektai importuojami TIK per siule `../core`.
SVARBU (patikrinta 2026-09-02): keturiu read portu (AgLoopUiReadPort, SessionReviewReadPort,
HostConnectionsReadPort, ProjectsReadPort) produkcinio adapterio NERA - juos implementuoja tik
testu fake'ai, o GatewayPort turi tik terminalo metodus. Todel read portu sis task'as NEkonstruoja
ir NEmeluoja, kad gali: kompozicija atiduoda tai, kas realiai egzistuoja.

## Agentai
Privaloma grandine: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidziama:
- `mobile-app/native/src/core.ts`
- `mobile-app/native/src/composition/native-runtime.ts`
- `mobile-app/native/src/tests/native-runtime.test.ts`
- `mobile-app/native/src/tests/core-seam.test.ts`

Draudziama:
- `mobile-app/native/src/composition/create-app-runtime.ts`
- `mobile-app/src/**`
- `mobile-app/native/package.json`

## Veiksmas
- Pradek nuo issaugoto antro bandymo darbo (jis jau turi core.ts siule): patch'as
  vq/state/worktree-archive/ag-worker-3f46de8f-4642-4c88-89d8-767c5ea90f49-118-native-shell-paleidzia-app--1a4b8bb5-a1.patch.
  core.ts eksportu sarasa papildyk GatewayHttpClient, TerminalStreamClient ir ju kontraktu tipais
  (MobileHttpTransportPort, MobileWebSocketPort, MobileWebSocketFactory, GatewayClientError).
- native-runtime.ts: RN fetch transportas, RN WebSocket factory, is ju GatewayHttpClient ir
  TerminalStreamClient; gateway bazinis URL - is aiskaus konfiguracijos tasko (tavo sprendimas,
  pagristas ataskaitoje), be nauju dependencies. Importai tik is `../core`.
- Testas native-runtime.test.ts: transportu adapteriai atitinka portu kontraktus (pavyzdys -
  esami gateway-http-client.test.ts kontraktai); core-seam.test.ts turi likti zalias be silpninimo.
  Papildomai paleisk pnpm test:mobile-app ir pnpm test:mobile-native ir irasyk rezultatus i ataskaita.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros ir mobile testai zali. Stop ir klausk, jei transporto adapteriui
pasirodytu butina nauja dependency, arba jei atrodytu, kad read portus reikia improvizuoti native
kiaute - to daryti negalima.

## Neitraukta
- index.js ir App.tsx komentaras - kita nuosekli uzduotis 118-b-02.
- Read portu HTTP adapteriai (mobile-app/src/adapters/network) - atskiras task'as, sio scope nera.
- expo-secure-store, biometrika, speech - task'ai 119, 120, 121.
