# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/ (UI auditas 2026-08-26, P2-3 ir P2-4)

## Tikslas
Grąžinti `/api/waves` skaitymą į bendrą HTTP klientą ir apsaugoti testu `assertOk` —
funkciją, kurią 2026-08-06 auditas pridėjo būtent tam, kad vartotojas matytų serverio
paaiškinimą, ir kuri iki šiol neturi nė vieno testo.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/model/api.ts`
- `ui-app/src/model/apiEnvelopes.test.ts`
- `ui-app/src/controller/useWavesController.ts`
- `ui-app/src/controller/useWavesController.test.ts`

Draudžiama:
- `src/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAS: `ui-app/src/controller/useWavesController.ts:22` kviečia `fetch("/api/waves")`
  tiesiogiai. Tokeną jis nustato teisingai, bet neturi `REQUEST_TIMEOUT_MS` abort'o — tai
  VIENINTELIS pollinamas skaitymas (kas 30 s) be timeout'o, tad pakibęs atsakymas kabo be
  ribos. `useAgentActivity.ts:79` irgi kviečia `fetch` tiesiogiai, bet TEISINGAI: SSE
  srautui timeout'as netaikomas — jo NEKEISTI.
- FAKTAS: jo klaidų parseris (`useWavesController.ts:25-34`) silpnesnis už `assertOk`
  (`api.ts:74`): kai kūnas ne JSON arba JSON be `error` lauko, jis praranda serverio
  paaiškinimą ir palieka vien `HTTP <status>`; `assertOk` tokiu atveju grąžina patį kūną
  ir prideda statusą.
- Perkelti `fetchWaves` į `ui-app/src/model/api.ts` kaip `fetchWaves()`, einantį per tą
  patį `request()` + `assertOk`. Kontroleris importuoja funkciją, o ne kalbasi su tinklu.
- Pridėti `assertOk` testus, dengiančius VISAS keturias šakas: JSON su `error`; JSON be
  `error`; ne-JSON kūnas; tuščias kūnas. Kiekvienu atveju tikrinti, kad žinutėje matyti IR
  statusas, IR paaiškinimas (kai jis yra), ir kad ilgis apkerpamas ties 300 simbolių.
- Testas kontroleriui: serverio 500 su paaiškinimu tekstiniame kūne pasiekia UI kaip tas
  paaiškinimas, o ne kaip `HTTP 500`.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei `useAgentActivity` SSE kelias imtų reikalauti
pakeitimų — jis sąmoningai lieka be timeout'o ir šio task'o apimčiai nepriklauso.

## Neįtraukta
- SSE srauto (`/api/events`) keitimas.
- Runtime validacija atsakymams (atskiras task).
- Backend pakeitimai.
