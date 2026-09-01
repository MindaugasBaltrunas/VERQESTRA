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
- `native/src/composition/native-runtime.ts`: konstruoja
  `gateway-http-client` (transportas — RN `fetch` per
  `MobileHttpTransportPort`) ir `terminal-stream-client` (RN `WebSocket` per
  `MobileWebSocketPort`), iš jų — read portus App'ui; gateway bazinį URL ima
  iš aiškaus konfigūracijos taško (vykdytojo sprendimas, pagrįstas
  ataskaitoje — be naujų dependencies).
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
