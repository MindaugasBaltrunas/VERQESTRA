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

## Tikslas
UI turi rodyti nematuotas celes: `ui-app/src/model/types.ts` gauna naujus laukus, o `BenchmarkPage` režimo tab'e atsiranda eilutė „Samples: measured N of M attempted (K refused)" su atmetimo priežasčių santrauka.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester. readme-guard eina pirmas ir grąžina ribų santrauką.

## Failai
Leidžiama:
- `ui-app/src/model/types.ts`
- `ui-app/src/view/pages/BenchmarkPage.tsx`
- `ui-app/src/view/pages/BenchmarkPage.test.tsx`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`
- `AG/benchmark/**`
- `src/**`

## Veiksmas
- Į `types.ts` pridėti adityvius optional laukus nematuotoms celėms, atitinkančius composition adapterio grąžinamą formą.
- `BenchmarkPage` režimo tab'e atvaizduoti aprėpties eilutę ir atmetimo priežasčių santrauką; kai laukų nėra (senas raportas), elgesys nesikeičia.
- Pridėti testą, kuris tikrina abu atvejus: su nematuotų celių laukais ir be jų.

## Patikra
- `pnpm --dir ui-app test`
- `pnpm build`

## Stop
Commit'ink iš karto, kai abi patikros žalios. Sustok, jei prireiktų keisti composition kontraktą ar `sampleCount` prasmę.

## Neįtraukta
- `AG/benchmark` raporto modelis, `suite-report-view` schema ir composition adapteris (atlikti ankstesniuose darbuose).
- Atmestų celių priežasčių taisymas (task 023) ir pakartotinis mokamas bėgimas.
