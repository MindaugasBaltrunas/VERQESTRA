# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `mobile-app/native/index.js` (dabar 6 eil.
`registerRootComponent(App)` be props) registruoja App SU sukonstruotais
portais (per kompozicijos modulį, kuris paduoda bent `agLoopReads` ir kitus
read portus iš `gateway-http-client`) — ALREADY_IMPLEMENTED: cituok
kompozicijos kodą ir props padavimą kaip įrodymą.

## Tikslas
Mobile audito P0 (2026-09-01): native shell paleidžia App BE portų, tad visi
ekranai amžinai „honest empty". Patikrinta: `mobile-app/native/index.js:6` —
`registerRootComponent(App)` be props; `native/src/App.tsx:47-61` — VISI
`AppProps` portai optional; 42-45 eil. komentaras žada, kad adapteriai
„land with the remaining adapter tasks" — tie task'ai niekada neatsirado.
SVARBU: platform-neutralūs adapteriai JAU EGZISTUOJA —
`mobile-app/src/adapters/network/gateway-http-client.ts` ir
`terminal-stream-client.ts` (eksportuoti per `mobile-app/src/index.ts:25-26`),
o kompozicijos siūlė `native/src/composition/create-app-runtime.ts` sąmoningai
laukia portų iš išorės (12-16 eil. doc'as). Sprendimas: native kompozicijos
modulis, kuris konstruoja tai, kas įmanoma be naujų platform dependencies —
HTTP transportą (React Native `fetch`) į `gateway-http-client`, WebSocket
transportą į `terminal-stream-client`, read portus (agLoopReads,
sessionReviewReads, connectionsReads, projectsReads) — ir paduoda į App.
Terminal/biometrikos/speech pilnas užvielinimas LIEKA daliniu: `writeGate`
reikalauja biometrikos adapterio (task 120), `speech` — task 121;
`secure-credential-store` — task 119. Iki jų App gauna read puses, o
Terminal ekranas toliau sąžiningai sako, ko trūksta — tai dizainas, ne bug'as.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `mobile-app/native/index.js`
- `mobile-app/native/src/composition/native-runtime.ts` (numatomas naujas —
  platform kompozicija; jei konvencija pareikalautų kito vardo — tas failas
  vietoje šio, įrašyti į ataskaitą)
- `mobile-app/native/src/App.tsx` (TIK 42-45 eil. komentaro atnaujinimas
  pagal realybę — props kontraktas nekinta)
- `mobile-app/native/src/core.ts` (SCOPE SPRAGOS PATAISA 2026-09-01, antro
  bandymo parkavimo pamoka: core.ts yra VIENINTELĖ leistina siūlė į
  mobile-app paketą — jo antraštės 1-4 eil. taisyklė, — tad kompozicija
  GatewayHttpClient ir TerminalStreamClient gali pasiekti TIK pridėjus jų
  eksportus čia; worker'io darytas keitimas worktree kopijoje buvo būtent
  šis ir buvo teisingas. Pagrindime backtick'ų nėra sąmoningai: parseris
  kiekvieną backtick tokeną skaičiuoja kaip failą — 2026-09-02 05:44 parkas
  „context files 10 > 8" buvo būtent šio pagrindimo trys tokenai)
- `mobile-app/native/src/tests/core-seam.test.ts` (siūlės paviršiaus testas
  — atnaujinamas kartu su naujais eksportais)
- `mobile-app/native/src/tests/native-shell-scaffold.test.ts`
- `mobile-app/native/src/tests/native-runtime.test.ts` (numatomas naujas)

Draudžiama:
- `mobile-app/native/src/composition/create-app-runtime.ts` (siūlė teisinga —
  portai ateina iš išorės; nekeičiama)
- `mobile-app/src/**` (platform-neutralus paketas — adapteriai jau yra,
  keisti nereikia)
- `mobile-app/native/package.json` (naujų dependencies ŠIS task'as neima —
  119-121 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Ankstesnių bandymų darbas išsaugotas dviejose vietose: (1) pirmo bandymo
  (2026-09-01 10:52) 5 failai —
  `refs/verqestra/preserved/9269be84cd53ecb1272a5d8e6dd64f13e7c61338`
  (įrašas `vq/state/rollback-preserved/118-native-shell-paleidzia-app-su-realiais-portais.json`);
  (2) antro bandymo (2026-09-01 15:06, vaikas baigė exit 0, parkas tik dėl
  `core.ts` už tuometinės ribos) šaka
  `ag/worker/3f46de8f-4642-4c88-89d8-767c5ea90f49/118-native-shell-paleidzia-app--1a4b8bb5/a1`
  ir jos archyvinis patch'as
  `vq/state/worktree-archive/ag-worker-3f46de8f-4642-4c88-89d8-767c5ea90f49-118-native-shell-paleidzia-app--1a4b8bb5-a1.patch`.
  Pradėk nuo antro bandymo (jis jau turi core.ts siūlę), ne nuo nulio.
- `core.ts`: į esamą eksportų sąrašą pridėti `GatewayHttpClient` ir
  `TerminalStreamClient` (bei kitus kompozicijai reikalingus vardus, jei jų
  trūksta) — kompozicija importuoja TIK iš `../core`, ne tiesiai iš
  `@verqestra/mobile-app` (siūlės taisyklė).
- `native/src/composition/native-runtime.ts`: konstruoja
  `gateway-http-client` (transportas — RN `fetch` per
  `MobileHttpTransportPort`) ir `terminal-stream-client` (RN `WebSocket` per
  `MobileWebSocketPort`) per `core` siūlę, iš jų — read portus App'ui;
  gateway bazinį URL ima iš aiškaus konfigūracijos taško (vykdytojo
  sprendimas, pagrįstas ataskaitoje — be naujų dependencies).
- `index.js`: `registerRootComponent` gauna App su kompozicijos
  sukonstruotais props (wrapper komponentas ar bind — vykdytojo pasirinkimas,
  išlaikant CommonJS entry pastabą 1-2 eil.).
- `App.tsx` 42-45 eil. komentaras: nebežada „remaining adapter tasks" —
  įvardija realią būseną (read portai užvielinti; writeGate/speech — 119-121).
- Testų lūkestis: (1) kompozicija paduoda ne-undefined read portus;
  (2) HTTP/WS transporto adapteriai atitinka portų kontraktus (esami
  `gateway-http-client.test.ts` kontraktai — pavyzdys); (3) esamas
  `native-shell-scaffold.test.ts` atnaujinamas be silpninimo.
- PATIKROS PASTABA: vykdytojas PRIVALO papildomai paleisti
  `pnpm test:mobile-app` ir `pnpm test:mobile-native` (šakniniai script'ai;
  `pnpm --dir ...` blokuoja bash hook'ai) ir rezultatus įrašyti į ataskaitą —
  `## Patikra` vartas mobile formų neleidžia.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros ir mobile testai žali. Stop ir klausk, jei
transporto adapteriams pasirodytų būtina nauja dependency — jos ėmimas ne
šio task'o apimtyje.

## Neįtraukta
- expo-secure-store / biometrikos / speech platform adapteriai ir jų
  dependencies — task'ai 119, 120, 121 (jie priklauso nuo šios kompozicijos
  siūlės).
- Lifecycle adapteris — `LifecyclePort` kode NEEGZISTUOJA (Grep 2026-09-01:
  jokio lifecycle porto `mobile-app/src`), verification-matrix minimas
  poreikis pirmiau reikalauja porto dizaino — atskiras task'as su architect
  žingsniu.
- Gateway paleidimas — task 117 (nepriklausomi paketai).
