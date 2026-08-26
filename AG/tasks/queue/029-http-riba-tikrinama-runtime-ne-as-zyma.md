# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/ (UI auditas 2026-08-26, P1-2)

## Tikslas
Įtvirtinti runtime patikrą per HTTP ribą ir pritaikyti ją dviem endpoint'ams. 2026-08-23
auditas jau nustatė, kad `as` per HTTP ribą nėra kontraktas, bet taisyklė liko pritaikyta
tik trims iš dešimties klientų — septyni tebekerta ribą su `as`.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/model/api.ts`
- `ui-app/src/model/dashboardContract.ts`
- `ui-app/src/model/apiEnvelopes.test.ts`
- `ui-app/src/model/types.ts`

Draudžiama:
- `src/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAS: `ui-app/src/model/api.ts` runtime tikrina TIK tris kelius —
  `parseDashboardData` (`:101`), `requireLoopEnvelope` (`:118`), `requireProposals`
  (`:233`). Septyni kiti grąžina `await (response.json() as Promise<T>)`: `:107`, `:155`,
  `:185`, `:257`, `:263`, `:282`, `:305`.
- Kaina konkreti: pasikeitęs ar sugadintas serverio atsakymas virsta `undefined` giliai
  renderyje (tuščias ekranas, neaiški React klaida), o ne įvardyta klaida su maršruto
  vardu — būtent tai, ką 2026-08-23 auditas ir uždarė dashboard'ui.
- Sukurti VIENĄ bendrą patikros primityvą greta esamų (`dashboardContract` stiliumi):
  jis privalo grąžinti tipą arba mesti klaidą, kurioje matyti MARŠRUTAS ir konkretus
  neatitikęs laukas. Tylus `undefined` draudžiamas.
- Pritaikyti jį DVIEMS endpoint'ams: `/api/compression` (`:305`) ir
  `/api/benchmark/report` (`:282`). Daugiau šiame task'e neliesti — mechanizmas pirma turi
  būti įrodytas, tik paskui platinamas (likusius dengia atskiras task).
- Patikra privalo būti STRUKTŪRINĖ, ne `typeof x === "object"`: tikrinami laukai, kuriuos
  UI realiai skaito, o trūkstamas laukas įvardijamas vardu.
- Testai: teisingas atsakymas praeina; trūkstamas laukas meta klaidą su maršrutu ir lauko
  vardu; `null` ir masyvas vietoj objekto irgi meta, o ne praslysta.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei patikra pareikalautų keisti serverio atsakymo
formą — kontraktą diktuoja serveris, ir jo keitimas yra atskiras sprendimas.

## Neįtraukta
- Likę penki `as` keliai (atskiras task).
- Serverio atsakymų formos keitimas.
- Zod ar kitos bibliotekos įvedimas be atskiro sprendimo.
