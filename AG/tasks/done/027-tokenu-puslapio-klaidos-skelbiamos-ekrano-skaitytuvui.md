## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/ (UI auditas 2026-08-26, P2-2)

## Tikslas
Suvienodinti klaidų skelbimą tokenų naudojimo puslapyje: nepavykęs įkėlimas privalo būti
skelbiamas ekrano skaitytuvui, kaip ir kituose puslapiuose. Dabar jis tyli.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/TokenUsagePage.tsx`
- `ui-app/src/view/pages/TokenUsagePage.test.tsx`

Draudžiama:
- `src/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAS: `ui-app/src/view/pages/TokenUsagePage.tsx:90` ir `:147` renderina klaidų juostas
  `<div className="notice" style={{ color: "var(--error)" }}>` BE `role="alert"`.
  Palyginimui `DashboardPage.tsx:116` ir `BenchmarkPage.tsx:140` klaidoms naudoja
  `role="alert"`. Ekrano skaitytuvas šiame puslapyje apie nepavykusį įkėlimą nepraneša.
- Abiem klaidų juostoms pridėti `role="alert"`. `:109` juosta yra INFORMACINĖ ir turi
  `role="status"` — jos NEKEISTI: `alert` pertraukia skaitymą ir tinka tik klaidai.
- Inline `style={{ color: "var(--error)" }}` pakeisti klase `notice notice-error`, kad
  klaidos atrodytų vienodai visuose puslapiuose ir spalva gyventų VIENOJE vietoje.
- Testas: kai `fetchTokenUsage` atmeta, puslapyje atsiranda elementas su
  `role="alert"`, kuriame matyti serverio paaiškinimas; informacinė juosta lieka `status`.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei paaiškėtų, kad `notice-error` klasė dar
neturi stiliaus — tada pirma turi būti įvykdytas task 026, ir šis laukia jo.

## Neįtraukta
- Kitų puslapių klaidų juostos.
- Klaidų teksto formulavimo keitimas.
- Backend pakeitimai.
