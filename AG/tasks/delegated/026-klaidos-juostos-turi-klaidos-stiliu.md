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
docs/audits/ (UI auditas 2026-08-26, P2-1)

## Tikslas
Duoti stilių CSS klasėms, kurios naudojamos TSX, bet `dashboard.css` neapibrėžtos.
Svarbiausia jų — `notice-error`: trys puslapiai ja žymi klaidų juostas, o vartotojas mato
neutralų pranešimą be klaidos afordanso.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/view/pages/**`
- `ui-app/src/view/components/**`

Draudžiama:
- `src/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAS: `ui-app/src/view/styles/dashboard.css` yra VIENINTELIS stilių šaltinis
  (patikrinta — kitų `.css` `ui-app/src` nėra). Jame apibrėžtas tik `notice-warning`;
  `notice-error` taisyklės nėra, nors ją naudoja `BenchmarkPage.tsx:140`,
  `ReliabilityPage.tsx` ir `CompressionPage.tsx`.
- Pridėti `.notice-error` taisyklę, semantiškai porinę su esama `.notice-warning`
  (klaidos spalvos žetonas, kontrastas abiejose temose — šviesioje ir tamsioje).
- Likusios 12 be stiliaus, tikrintinos po vieną: `benchmark-verdict-panel`,
  `benchmark-conclusions`, `benchmark-duel`, `cost-trend-panel`,
  `task-concentration-panel`, `reliability-token-panel`, `failure-search`,
  `policy-form-error`, `system-signals`, `signal-neutral`, `signal-warning`,
  `current`/`available` (`PolicyControlsPanel`). Kiekvienai — VIENAS iš dviejų sprendimų:
  arba taisyklė atsiranda, arba klasė pašalinama iš TSX kaip nereikalinga. Trečio kelio
  („palikti kaboti") nėra.
- Pridėti VARTĄ, kad spraga nebeatsirastų: testas, kuris surenka literalines `className`
  reikšmes iš `ui-app/src/**/*.tsx` ir tikrina, kad kiekviena turi taisyklę
  `dashboard.css`. Dinaminės dalys (`${…}`) iš tikrinimo išimamos — jos neišvengiamos.
- Vartas privalo kristi ant DABARTINĖS būsenos prieš taisymą; tai jo teisingumo įrodymas.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai patikros žalios IR naujas vartas praeina. Sustok, jei paaiškėtų, kad kuri
nors klasė turi stilių kitoje vietoje (pvz. inline) — tada radinys yra klaidingas ir
sprendimą priima operatorius.

## Neįtraukta
- Vizualinis dizaino perdarymas.
- Temų sistemos keitimas.
- Backend pakeitimai.
