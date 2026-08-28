## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

DĖMESIO: ankstesnis šio task'o bėgimas buvo nukirstas ties turn limitu — dalis
pakeitimų GALI jau būti kode. Patikrink kiekvieną ## Veiksmas punktą atskirai
ir daryk tik trūkstamus.

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe, be `build:ui` ar kitų variantų — jie ATMETAMI).
- `echo`, `sed`, `find`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams ieškoti/skaityti naudok Glob/Grep/Read tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review.

# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus nurodymas — build valdymas turi būti mygtuku iš panelės (rankinis skėlimas: čia UI dalis, serverio dalis — 058, jau DONE)

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
UI pusė dashboard'o perbuild valdymui. Serverio dalis (058) JAU PADARYTA:
`POST /api/ui/rebuild` endpoint'as ir `bundle_stale`/`bundle_built_at`
laukai view atsakyme egzistuoja — šis task'as prijungia juos UI:

1. **Įspėjimas apie pasenusį bundle**: kai view atsakyme `bundle_stale`,
   System puslapyje rodomas aiškus notice „Rodomas dashboard'as senesnis
   už šaltinius" su perbuild mygtuku šalia.
2. **Mygtukas „Perbuild'inti dashboard'ą"** RuntimePanel ciklo valdymo
   juostoje: paspaudus POST `/api/ui/rebuild`; būsenos: vykdoma (mygtukas
   disabled su priežastimi title atribute) → pavyko (siūlo perkrauti
   puslapį) → klaida (rodo `reason`). Atsakymas `already-running` rodomas
   kaip vykdoma, ne kaip klaida.

Dizainas: aiškios būsenos, jokių amžinų animacijų, abi temos, tekstai per
`t(...)`, naujos className su taisyklėmis `dashboard.css`.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/model/api.ts`
- `ui-app/src/model/types.ts`
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**` (serverio dalis jau padaryta 058)
- `ui-app/src/controller/**`
- `dist/**`
- `node_modules/**`

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Serverio endpoint'as ir staleness skaičiavimas (padaryta 058). Automatinis
perbuild'as po loop task'ų. Websocket auto-reload — užtenka pasiūlymo
perkrauti puslapį.
