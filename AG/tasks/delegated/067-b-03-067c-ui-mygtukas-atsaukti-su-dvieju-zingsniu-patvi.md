## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1 (task 067, 3/3 dalis; priklauso nuo 067 2/3)

## Tikslas
Sprendimu eileje (`PolicyProposalsPanel`) prie 'pending' ir 'approved' pasiulymo rodyti mygtuka 'Atsaukti' su dvieju zingsniu patvirtinimu (kaip `HumanReviewPanel`). Atsauktas pasiulymas keliauja i History skirtuka su 'cancelled' zenkleliu, o `PolicyControlsPanel` korteles 'Pending proposal' blokas atsauktu nebereodo.

## Agentai
Privaloma naudoti butent sia grandine: readme-guard -> coder -> reviewer -> i18n -> tester

## Failai
Leidziama:
- `ui-app/src/App.tsx`
- `ui-app/src/App.test.tsx`
- `ui-app/src/model/api.ts`
- `ui-app/src/model/types.ts`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudziama:
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `types.ts` + `api.ts`: prideti 'cancel' verb'a ir 'cancelled' statusa, iskvietimas i esama proposals endpoint'a.
- `App.tsx`: mygtukas 'Atsaukti' tik pending/approved eiluteje su dvieju zingsniu patvirtinimu; 'cancelled' pasiulymas rodomas History skirtuke su zenkleliu ir dingsta is 'Pending proposal' bloko.
- i18n raktai abiem kalbom ir `dashboard.css` taisykles kiekvienai naujai className; testai `App.test.tsx` patvirtinimo srautui ir History filtravimui.

## Patikra
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai abi patikros zalios. Sustok, jei serverio 'cancel' verb'as dar neatsakinejа - tada blokuok, nes ankstesne dalis nebaigta.

## Neitraukta
Serverio logika ir HTTP route (1/3 ir 2/3 dalys). Masinis atsaukimas. Jau pritaikytu ('applied') pakeitimu atstatymas. Kitu Reviews bloku keitimai.
