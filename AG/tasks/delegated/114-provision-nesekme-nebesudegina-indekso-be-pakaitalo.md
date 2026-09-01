## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/wave-provisioning.ts`
`provisionMissingSlotLeases` po nepavykusio `provisionSlotLease` (dabar 414
eil. `continue`) ieško pakaitalo ta pačia tvarka kaip write-set-conflict šaka
(dabar 388-411 eil.) — ALREADY_IMPLEMENTED: cituok pakaitalo paieškos kodą
nesėkmės šakoje ir jo testą kaip įrodymą.

## Tikslas
W1/w2 slot'ų audito P2 (2026-09-01): kandidatui specifinė provision nesėkmė
sudegina vienintelį laisvą indeksą be pakaitalo, ir deterministinė tvarka gali
badauti w2 amžinai. Patikrinta `wave-provisioning.ts`: write-set-conflict
šaka (388-411 eil.) pakaitalo paiešką TURI — „Slot'as neprarandamas: jį gauna
ŽEMIAUSIAS eilėje kandidatas" (395-397 eil. komentaras); bet
`provisionSlotLease` nesėkmė (414 eil.) daro tik `continue` — indeksas
prarandamas iki kitos bangos. Kandidatui SPECIFINĖS nesėkmės, kurios kartosis
tam pačiam kandidatui: reused lease priklauso kitam task'ui (210-214 eil.),
lease konfliktas su svetimu owner'iu (202-206 eil.) — o kita banga
deterministine tvarka vėl ims TĄ PATĮ kandidatą, vėl kris ir vėl sudegins
indeksą: galimas amžinas w2 badavimas, nors eilėje stovi sveiki kandidatai.
Sprendimas: nesėkmės šakai pridėti TĄ PAČIĄ pakaitalo paiešką kaip conflict
šakai (tie patys filtrai: !claimed, !granted, !running, !started, be lease,
missingLease, be write-set konflikto su occupants), su saugikliu nuo begalinio
ciklo (kandidatų aibė baigtinė — kiekvienas bandomas daugiausia kartą per
raundą).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/wave-provisioning.ts`
- `src/tests/scheduling-wave-provisioning.test.ts`

Draudžiama:
- `src/application/scheduling/worker-pool-plan.ts` (hard-cap žinutė —
  task 113)
- `src/application/scheduling/wave-pool-planning.ts` (pool eilutė —
  task 116)
- `src/application/scheduling/worker-lease-store.ts` (lease semantika
  nekeičiama)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `wave-provisioning.ts` (`provisionMissingSlotLeases`): 414 eil. `continue`
  pakeisti pakaitalo ciklu — nepavykus `provisionSlotLease(resolved)`,
  bandomas kitas kandidatas ta pačia deterministine tvarka ir tais pačiais
  filtrais kaip conflict šakoje (398-407 eil.); tikslinga bendrą pakaitalo
  atrankos išraišką iškelti į vieną vietinę funkciją, kad abi šakos
  nesiskirtų (kopija vėl išsiskirtų). Kiekvienas bandytas kandidatas žymimas
  `claimed`, tad raundas baigtinis.
- Log'e pakaitalo bandymas matomas: kuris kandidatas krito, kuris bandomas
  vietoje jo — operatorius turi matyti grandinę, ne tik galutinį rezultatą.
- Testų lūkestis (`scheduling-wave-provisioning.test.ts`): (1) regresija —
  pirmo kandidato `provisionSlotLease` grąžina false (pvz. reused-foreign
  lease), antras sveikas kandidatas TĄ PATĮ indeksą gauna tame pačiame
  raunde; (2) visi kandidatai krenta → raundas baigiasi be išdavimo ir be
  begalinio ciklo; (3) esami conflict-šakos pakaitalo testai lieka žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei pakaitalo ciklas
atskleistų, kad `provisionSlotLease` šalutiniai efektai (lease acquire/release
seka) nepakeliami kartoti keliems kandidatams viename raunde — tai būtų lease
store kontrakto klausimas.

## Neįtraukta
- Hard-cap žinutės tiesa — task 113 (kitas failas).
- Provision nesėkmės priežasties iškėlimas į pool eilutę — task 116
  (priklauso nuo šio task'o failo).
- Karantinuotų/svetimų lease'ų valymo politika — orphan reaper scope
  (064 serija, jau done).
