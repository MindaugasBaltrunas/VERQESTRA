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
openspec/changes/verqestra-backlog-v1/

## Tikslas
Audituoti dashboard punktus 3 ir 4:
3. `WavesPanel` tuščia lentelė įvardija priežastį (worktree politikos būsena), o ne rodo tuščią rėmelį.
4. `LoopControls` ciklo mygtukai turi `title` su priežastimi, kai neaktyvūs; prie „Stabdyti" yra drain subtekstas.
Kiekvieną punktą pažymėti ✅/❌ su `failas:eilutė` įrodymu. Priklauso nuo 069-a.

## Agentai
PRIVALOMA grandinė: readme-guard -> reviewer -> coder -> tester. readme-guard pirmas.

## Failai
Leidžiama:
- `ui-app/src/view/components/WavesPanel.tsx`
- `ui-app/src/view/components/WavesPanel.test.tsx`
- `ui-app/src/view/components/LoopControls.tsx`
- `ui-app/src/view/components/LoopControls.test.tsx`
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/i18n/I18nContext.tsx`

Draudžiama:
- `ui-app/src/model/**`
- `ui-app/src/controller/**`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Read `WavesPanel.tsx`: patikrinti tuščios būsenos šaką — ar ji įvardija worktree politikos priežastį; jei tekstas yra, bet be `title`/aria konteksto, taisyti čia.
- Read `LoopControls.tsx`: patikrinti, ar kiekvienas disabled mygtukas turi `title` su priežastimi ir ar „Stabdyti" turi drain subtekstą; trūkstamus `title` pridėti.
- Ataskaitoje pažymėti punktus 3 ir 4 su `failas:eilutė`; trūkstamą i18n raktą ar CSS taisyklę TIK įrašyti, NETAISYTI.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios ir punktai 3, 4 pažymėti su įrodymais. Sustok, jei trūksta visos tuščios būsenos šakos — didelis neatitikimas eina į ataskaitą su siūlomu atskiru task'u.

## Neįtraukta
CSS ir i18n pataisymai (069-a). SystemStatusHero ir RuntimePanel (069-b). Reviews forma (069-d). Slotai ir sprendimų eilė (069-e). Galutinis build (069-f). Serverio kodas, mobile.
